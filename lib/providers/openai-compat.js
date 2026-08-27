/**
 * OpenAI 兼容供应商：通用工厂 + 官方目录驱动的预置实例。
 *
 * - `defineOpenAiCompatProvider(cfg)`：通用工厂——供"官方目录未列举"的
 *   自定义供应商使用（用户自行配置时按此模板接入）。
 * - `catalogProviders()`：从 `catalog.generated.js`（由
 *   scripts/sync-providers.js 从 Harness 内置 pi-ai 官方目录生成）构建全部
 *   预置供应商——与 Harness 模型配置后台的提供方列表完全对齐，价格即官方
 *   目录价（USD / 1M tokens，双币种按 1 USD = 7.2 CNY 换算展示）。
 * - `BALANCE_ADAPTERS`：有公开余额接口的供应商单独适配；其余供应商余额
 *   查询不可用（fetchBalance 返回 null），会话费用计价照常工作。
 * @import { ProviderContract, TokenUsage, PriceUnit, HostContext, BalanceInfo } from "../types.js"
 */
import { costOf } from "./deepseek-pricing.js";
import { PI_AI_CATALOG, PI_AI_CATALOG_META } from "./catalog.generated.js";

export { PI_AI_CATALOG_META };

/** 目录条目（catalog.generated.js 成员）。
 * @typedef {{id: string, displayName: string|null, baseUrl: string|null, models: Record<string, {input: number, cacheRead: number, output: number}>}} CatalogEntry
 */

/**
 * defineOpenAiCompatProvider 的配置。
 * @typedef {object} OpenAiCompatConfig
 * @property {string} id 稳定标识。
 * @property {string} displayName 显示名。
 * @property {string} baseUrl OpenAI 兼容端点。
 * @property {string[]=} baseUrlHosts 归属识别的 hostname 列表。
 * @property {string[]=} aliases Harness provider id 别名。
 * @property {string=} keyRef 凭证引用名。
 * @property {string=} currency 展示主币种（默认 USD）。
 * @property {string=} defaultModel 默认模型（展示用）。
 * @property {string=} balancePath 余额接口路径（缺省 = 无公开余额接口）。
 * @property {((body: any, text: string) => BalanceInfo|null)=} balanceExtract 余额响应提取器。
 * @property {Record<string, {input: number, cacheRead: number, output: number}>} prices 目录价（USD/1M；"*" 为显式兜底价）。
 * @property {string} planLabel 套餐说明文案。
 * @property {"token"|"subscription"|"credit"=} planKind 计费方式。
 */

const USD_CNY_RATE = 7.2;
const TIMEOUT_MS = 15000;

/**
 * @param {{input: number, cacheRead: number, output: number}} entry
 * @param {number} rate
 */
function scaleUnit(entry, rate) {
  return {
    input: entry.input * rate,
    cacheRead: entry.cacheRead * rate,
    output: entry.output * rate
  };
}

/** 目录价以 USD 计；双币种按固定汇率换算。
 * @param {{input: number, cacheRead: number, output: number}} entry
 */
function dualUnitUsd(entry) {
  return { usd: entry, cny: scaleUnit(entry, USD_CNY_RATE) };
}

/**
 * @param {unknown} value
 * @returns {number} 非有限输入返回 NaN。
 */
function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * 通用 OpenAI 兼容 provider 工厂：两级价格索引（full exact > 唯一 basename），
 * 未命中一律返回 null（fail closed），绝不按 0 元静默计费。
 * @param {OpenAiCompatConfig} cfg
 * @returns {ProviderContract}
 */
export function defineOpenAiCompatProvider(cfg) {
  const {
    id, displayName, baseUrl, baseUrlHosts = [], aliases = [],
    keyRef, currency = "USD", defaultModel = "*",
    balancePath, balanceExtract, prices, planLabel, planKind = "token"
  } = cfg;
  const subscriptionCatalog = Object.values(prices).length > 0
    && Object.values(prices).every((entry) => entry.input === 0 && entry.cacheRead === 0 && entry.output === 0);

  // 两级索引，优先级明确：
  //   1) 完整 catalog id 做 case-insensitive exact match；
  //   2) exact 未命中才尝试 basename alias，且 basename 唯一时才可用；
  //   3) 歧义（多个 catalog key 同 basename）fail closed。
  /** @type {Map<string, string>} */
  const exactIndex = new Map();
  /** @type {Map<string, string[]>} */
  const bareIndex = new Map();
  for (const key of Object.keys(prices)) {
    exactIndex.set(key.toLowerCase(), key);
    // 只有 catalog canonical key 本身不含 "/" 时才允许 basename alias。
    // 含 "/" 的 ID（如 deepseek-ai/DeepSeek-V4-Pro）一律要求 full exact，
    // 避免把 bar/model-x 猜成唯一的 foo/model-x 价格。
    if (!key.includes("/")) {
      const bare = key.toLowerCase();
      const list = bareIndex.get(bare) ?? [];
      list.push(key);
      bareIndex.set(bare, list);
    }
  }
  /**
   * @param {unknown} model
   * @returns {string|null}
   */
  const catalogKeyFor = (model) => {
    if (typeof model !== "string" || model.trim() === "") return null;
    const normalized = model.trim().toLowerCase();
    const exact = exactIndex.get(normalized);
    if (exact !== void 0) return exact;
    const bare = normalized.split("/").at(-1) ?? normalized;
    const matches = bareIndex.get(bare);
    return matches !== void 0 && matches.length === 1 ? matches[0] : null;
  };

  return {
    id,
    displayName,
    currency,
    aliases,
    baseUrlHosts,
    defaultModel,
    keyRef,
    plan: subscriptionCatalog
      ? { kind: "subscription", label: "套餐额度 · 无可换算的按量价格" }
      : { kind: planKind, label: planLabel },
    pricingUnavailableReason: subscriptionCatalog ? "subscription_plan" : undefined,

    /**
     * @param {unknown} model
     * @param {number} _timeMs
     */
    priceAt(model, _timeMs) {
      if (subscriptionCatalog) return null;
      // fail closed：目录里没有这个模型时返回 null，调用方标记"暂无价格"，
      // 绝不按 0 元静默计费。`*` 仅作为供应商显式配置的兜底价。
      const key = catalogKeyFor(model);
      let entry = key !== null ? prices[key] : void 0;
      if (entry === void 0) entry = prices["*"];
      if (entry === void 0) return null;
      return { ...dualUnitUsd(entry), mode: "flat", source: `pi-ai@${PI_AI_CATALOG_META.sourceVersion}` };
    },

    /**
     * @param {TokenUsage} usage
     * @param {PriceUnit} unit
     */
    costOf(usage, unit) {
      // USD/CNY 按对应币种单价计；其它展示币种（如 OpenRouter 的 credits）
      // 按 1:1 使用 USD 价，nativeCurrency 仍保留展示币种。
      const result = costOf(usage, unit, currency === "CNY" ? "CNY" : "USD");
      if (currency !== "CNY" && currency !== "USD") result.nativeCurrency = currency;
      return result;
    },

    /** 无公开余额接口的供应商返回 null（调用方显示"无余额接口"）。
     * @param {HostContext} ctx
     * @returns {Promise<BalanceInfo>}
     */
    async fetchBalance(ctx) {
      if (balancePath === void 0 || balanceExtract === void 0 || keyRef === void 0) return null;
      const hit = await ctx.credentials?.resolve(keyRef);
      if (hit === undefined || hit === null || typeof hit.value !== "string") {
        const error = new Error(`未配置 ${keyRef}：请先在 Harness 凭证中填写 ${displayName} 的 API Key。`);
        /** @type {Error & {code?: string}} */ (error).code = "no-api-key";
        throw error;
      }
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${balancePath}`, {
        headers: { Authorization: `Bearer ${hit.value}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${displayName} 余额接口返回 HTTP ${response.status}`);
        /** @type {Error & {code?: string}} */ (error).code = "provider";
        throw error;
      }
      let body = null;
      try { body = JSON.parse(text); } catch {}
      const extracted = balanceExtract(body, text);
      if (extracted === null || extracted === void 0) {
        const error = new Error(`${displayName} 余额响应结构无法识别`);
        /** @type {Error & {code?: string}} */ (error).code = "provider";
        throw error;
      }
      return { available: true, ...extracted };
    }
  };
}

/** 有公开余额接口的供应商适配（其余供应商余额不可用，费用计价照常）。
 * @type {Record<string, {keyRef: string, currency: string, balancePath: string, defaultModel?: string, balanceExtract: (body: any) => BalanceInfo|null}>}
 */
const BALANCE_ADAPTERS = {
  "moonshotai": {
    keyRef: "MOONSHOT_API_KEY",
    currency: "CNY",
    balancePath: "/v1/users/me/balance",
    /**
     * @param {{data?: any}} body
     * @returns {BalanceInfo|null}
     */
    balanceExtract: (body) => {
      const d = body?.data;
      if (d === void 0 || d === null) return null;
      return {
        total: toFinite(d.available_balance),
        granted: toFinite(d.voucher_balance ?? 0),
        toppedUp: toFinite(d.cash_balance ?? 0),
        currency: d.currency ?? "CNY"
      };
    }
  },
  "moonshotai-cn": {
    keyRef: "MOONSHOT_API_KEY",
    currency: "CNY",
    balancePath: "/v1/users/me/balance",
    /**
     * @param {{data?: any}} body
     * @returns {BalanceInfo|null}
     */
    balanceExtract: (body) => {
      const d = body?.data;
      if (d === void 0 || d === null) return null;
      return {
        total: toFinite(d.available_balance),
        granted: toFinite(d.voucher_balance ?? 0),
        toppedUp: toFinite(d.cash_balance ?? 0),
        currency: d.currency ?? "CNY"
      };
    }
  },
  "openrouter": {
    keyRef: "OPENROUTER_API_KEY",
    currency: "credits",
    balancePath: "/api/v1/auth/key",
    /**
     * @param {{data?: any}} body
     * @returns {BalanceInfo|null}
     */
    balanceExtract: (body) => {
      const d = body?.data;
      if (d === void 0 || d === null) return null;
      return {
        total: toFinite(d.limit_remaining),
        granted: 0,
        toppedUp: toFinite(d.usage ?? 0),
        available: d.limit === null || toFinite(d.limit_remaining) > 0,
        currency: "credits"
      };
    }
  }
};

/**
 * @param {string} url
 * @returns {string[]}
 */
function hostOf(url) {
  try { return [new URL(url).hostname]; } catch { return []; }
}

/** 由官方目录条目构建预置 provider（无余额适配则余额查询不可用）。
 * @param {CatalogEntry} entry
 * @returns {ProviderContract}
 */
function catalogProvider(entry) {
  const adapter = BALANCE_ADAPTERS[entry.id];
  return defineOpenAiCompatProvider({
    id: entry.id,
    displayName: entry.displayName ?? entry.id,
    baseUrl: /** @type {string} */ (entry.baseUrl),
    baseUrlHosts: hostOf(/** @type {string} */ (entry.baseUrl)),
    aliases: [entry.id],
    keyRef: adapter?.keyRef,
    currency: adapter?.currency ?? "USD",
    defaultModel: adapter?.defaultModel ?? "*",
    balancePath: adapter?.balancePath,
    balanceExtract: adapter?.balanceExtract,
    prices: entry.models,
    planLabel: adapter !== void 0
      ? "按量计费 · 官方目录价格（USD/1M）"
      : "按量计费 · 官方目录价格（无公开余额接口）",
    planKind: entry.id === "openrouter" ? "credit" : "token"
  });
}

/** 全部官方目录预置供应商（不含 deepseek——它由专用 provider 提供峰谷精确计价）。
 * @returns {ProviderContract[]}
 */
export function catalogProviders() {
  // 生成数据与 CatalogEntry 结构一致（sync-providers 保证）；此处为视图断言。
  const entries = /** @type {CatalogEntry[]} */ (/** @type {unknown} */ (PI_AI_CATALOG));
  return entries
    .filter((entry) => entry.id !== "deepseek" && typeof entry.baseUrl === "string")
    .map((entry) => catalogProvider(entry));
}
