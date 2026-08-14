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
 */
import { costOf } from "./deepseek-pricing.js";
import { PI_AI_CATALOG } from "./catalog.generated.js";

const USD_CNY_RATE = 7.2;
const TIMEOUT_MS = 15000;

function scaleUnit(entry, rate) {
  return {
    input: entry.input * rate,
    cacheRead: entry.cacheRead * rate,
    output: entry.output * rate
  };
}

/** 目录价以 USD 计；双币种按固定汇率换算。 */
function dualUnitUsd(entry) {
  return { usd: entry, cny: scaleUnit(entry, USD_CNY_RATE) };
}

function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

export function defineOpenAiCompatProvider(cfg) {
  const {
    id, displayName, baseUrl, baseUrlHosts = [], aliases = [],
    keyRef, currency = "USD", defaultModel = "*",
    balancePath, balanceExtract, prices, planLabel, planKind = "token"
  } = cfg;

  return {
    id,
    displayName,
    currency,
    aliases,
    baseUrlHosts,
    defaultModel,
    keyRef,
    plan: { kind: planKind, label: planLabel },

    priceAt(model, _timeMs) {
      const entry = prices[model] ?? prices["*"] ?? { input: 0, cacheRead: 0, output: 0 };
      return { ...dualUnitUsd(entry), mode: "flat" };
    },

    costOf(usage, unit) {
      return costOf(usage, unit);
    },

    /** 无公开余额接口的供应商返回 null（调用方显示"无余额接口"）。 */
    async fetchBalance(ctx) {
      if (balancePath === void 0 || balanceExtract === void 0 || keyRef === void 0) return null;
      const hit = await ctx.credentials.resolve(keyRef);
      if (hit === void 0) {
        const error = new Error(`未配置 ${keyRef}：请先在 Harness 凭证中填写 ${displayName} 的 API Key。`);
        error.code = "no-api-key";
        throw error;
      }
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${balancePath}`, {
        headers: { Authorization: `Bearer ${hit.value}`, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`${displayName} 余额接口返回 HTTP ${response.status}`);
        error.code = "provider";
        throw error;
      }
      let body = null;
      try { body = JSON.parse(text); } catch {}
      const extracted = balanceExtract(body, text);
      if (extracted === null || extracted === void 0) {
        const error = new Error(`${displayName} 余额响应结构无法识别`);
        error.code = "provider";
        throw error;
      }
      return { available: true, ...extracted };
    }
  };
}

/** 有公开余额接口的供应商适配（其余供应商余额不可用，费用计价照常）。 */
const BALANCE_ADAPTERS = {
  "moonshotai": {
    keyRef: "MOONSHOT_API_KEY",
    currency: "CNY",
    balancePath: "/v1/users/me/balance",
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

function hostOf(url) {
  try { return [new URL(url).hostname]; } catch { return []; }
}

/** 由官方目录条目构建预置 provider（无余额适配则余额查询不可用）。 */
function catalogProvider(entry) {
  const adapter = BALANCE_ADAPTERS[entry.id];
  return defineOpenAiCompatProvider({
    id: entry.id,
    displayName: entry.displayName ?? entry.id,
    baseUrl: entry.baseUrl,
    baseUrlHosts: hostOf(entry.baseUrl),
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

/** 全部官方目录预置供应商（不含 deepseek——它由专用 provider 提供峰谷精确计价）。 */
export function catalogProviders() {
  return PI_AI_CATALOG
    .filter((entry) => entry.id !== "deepseek")
    .map(catalogProvider);
}
