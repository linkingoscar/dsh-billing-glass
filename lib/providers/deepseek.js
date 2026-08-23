/**
 * DeepSeek provider —— 默认供应商，注册表里排第一位（悬浮卡优先展示）。
 *
 * - 余额：官方 GET /user/balance（复用 DEEPSEEK_API_KEY 凭证，Key 不出本机）
 * - 今日消费：仅配置 DEEPSEEK_PLATFORM_TOKEN 时显示官方平台数据；不配置则不显示
 *   （余额差估算会受充值/退款影响，不再作为展示口径，避免统计混淆）
 * - 计价：官方价格政策链 + 峰谷时段（见 deepseek-pricing.js）
 *
 * 注意：本插件零外部运行时依赖（link:/git 安装即可用）。
 * `ctx.credentials.resolve` 接受纯字符串凭证引用
 * （@deepseek-ai/dsh-credentials 的 credentialRef 只是模式校验后原样返回）。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { priceAt, costOf } from "./deepseek-pricing.js";
import { parseOfficialPage, compareWithBuiltin } from "./deepseek-refresh.js";

/** @import { ProviderContract, HostContext, TokenUsage, PriceUnit } from "../types.js" */

const PUBLIC_BASE_URL = "https://api.deepseek.com";
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
const CREDENTIAL_REF = "DEEPSEEK_API_KEY";
const PLATFORM_TOKEN_REF = "DEEPSEEK_PLATFORM_TOKEN";
const PLATFORM_USAGE_URL = "https://platform.deepseek.com/api/v0/usage/cost";
const PRICING_PAGE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const PRICING_SNAPSHOT_FILE = "billing-glass-pricing-snapshot.html";
const BALANCE_PATH = "/user/balance";
const TIMEOUT_MS = 15000;
// 官方平台"今日/本月"账务日界线显式固定为北京时间，不跟随 host 时区。
const DEEPSEEK_ACCOUNTING_TIMEZONE = "Asia/Shanghai";

/** 余额接口 URL（env 可覆盖 base）。
 * @returns {string}
 */
function balanceUrl() {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}${BALANCE_PATH}`;
}

/** 指定账务时区的日历日 `YYYY-MM-DD`（默认北京时间）。
 * @param {Date=} d
 * @param {string=} timezone
 * @returns {string}
 */
export function localDate(d = new Date(), timezone = DEEPSEEK_ACCOUNTING_TIMEZONE) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(d);
    const get = (/** @type {string} */ type) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
}

/** storages 目录路径（定价页快照等持久化用）。
 * @param {HostContext|undefined} ctx
 * @returns {string}
 */
function storagesPath(ctx) {
  const homeFn = typeof ctx?.get === "function" ? ctx.get("dshHomePath") : void 0;
  if (typeof homeFn === "function") return /** @type {(name: string) => string} */ (homeFn)("storages");
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, "storages");
  return join(homedir(), ".dsh", "storages");
}

/** 提取 DeepSeek 错误正文里的可读信息。
 * @param {string} text
 * @param {number} status
 * @returns {string}
 */
function providerMessage(text, status) {
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {}
  return `DeepSeek 接口返回 HTTP ${status}`;
}

// ---- 今日消费：官方平台数据（可选，配 DEEPSEEK_PLATFORM_TOKEN 时启用） ----

/**
 * @param {unknown} value
 * @returns {number}
 */
function toFinitePlatform(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * 解析平台用量接口响应，取"今天"这一行的消费总额。
 * 响应信封（防御性解析）：{ code: 0, data: { biz_code: 0, biz_data: {
 *   days: [ { date: "YYYY-MM-DD", data: [ { usage: [ { cost|amount } ] } ] } ]
 * } } }。结构不符或今天无行时返回 null（调用方回退余额差估算）。
 * @param {any} body
 * @param {string=} today
 * @returns {number|null}
 */
export function parsePlatformTodayCost(body, today = localDate()) {
  const biz = body !== null && typeof body === "object" ? body.data : void 0;
  if (body?.code !== 0 || biz === void 0 || biz.biz_code !== 0) {
    const code = body?.code ?? biz?.biz_code;
    if (code === 40002 || code === 40003) {
      throw new Error("DEEPSEEK_PLATFORM_TOKEN 已过期：请重新登录 platform.deepseek.com 并更新 userToken");
    }
    throw new Error(`DeepSeek 平台用量接口错误 (code ${code ?? "unknown"})`);
  }
  const bizData = biz.biz_data;
  const container = Array.isArray(bizData) ? bizData[0] : bizData;
  const days = container !== null && typeof container === "object" ? container.days : void 0;
  if (!Array.isArray(days)) return null;
  const entry = days.find((d) => d !== null && typeof d === "object" && d.date === today);
  if (entry === void 0 || !Array.isArray(entry.data)) return null;
  let total = 0;
  for (const modelEntry of entry.data) {
    if (modelEntry === null || typeof modelEntry !== "object" || !Array.isArray(modelEntry.usage)) continue;
    for (const u of modelEntry.usage) {
      if (u === null || typeof u !== "object") continue;
      const value = toFinitePlatform(u.cost ?? u.amount);
      if (Number.isFinite(value)) total += value;
    }
  }
  return Math.round(total * 100) / 100;
}

/** 拉官方平台今日消费（platform.deepseek.com 前端内部接口）。
 * @param {string} token
 * @param {string=} timezone
 * @returns {Promise<number|null>}
 */
async function fetchPlatformTodayCost(token, timezone = DEEPSEEK_ACCOUNTING_TIMEZONE) {
  const now = new Date();
  const today = localDate(now, timezone);
  const month = Number(today.slice(5, 7));
  const year = Number(today.slice(0, 4));
  const url = `${PLATFORM_USAGE_URL}?month=${month}&year=${year}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "x-app-version": "1.0.0",
      Origin: "https://platform.deepseek.com",
      Referer: "https://platform.deepseek.com/usage"
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`DeepSeek 平台用量接口返回 HTTP ${response.status}`);
  return parsePlatformTodayCost(await response.json(), today);
}

/** @type {ProviderContract} */
export const deepseek = {
  id: "deepseek",
  displayName: "DeepSeek",
  currency: "CNY",
  aliases: ["deepseek-official"],
  baseUrlHosts: ["api.deepseek.com"],
  defaultModel: "deepseek-v4-pro",
  accountingTimezone: DEEPSEEK_ACCOUNTING_TIMEZONE,
  keyRef: "DEEPSEEK_API_KEY",
  plan: {
    kind: "token",
    label: "按量计费 · 官方价格政策（含峰谷时段）"
  },

  /**
   * @param {HostContext} ctx
   * @returns {Promise<{total: number, granted: number, toppedUp: number, available: boolean, currency: string, raw: unknown}>}
   */
  async fetchBalance(ctx) {
    const hit = await ctx.credentials?.resolve(CREDENTIAL_REF);
    if (hit === undefined || hit === null || typeof hit.value !== "string") {
      const error = new Error("未配置 DEEPSEEK_API_KEY：请在 设置 → 模型 中填写 DeepSeek API Key。");
      /** @type {Error & {code?: string}} */ (error).code = "no-api-key";
      throw error;
    }
    const response = await fetch(balanceUrl(), {
      headers: { Authorization: `Bearer ${hit.value}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(providerMessage(text, response.status));
      /** @type {Error & {code?: string}} */ (error).code = "provider";
      throw error;
    }
    let body = null;
    try { body = JSON.parse(text); } catch {}
    const info = Array.isArray(body?.balance_infos) ? body.balance_infos[0] : null;
    return {
      total: Number(info?.total_balance ?? NaN),
      granted: Number(info?.granted_balance ?? 0),
      toppedUp: Number(info?.topped_up_balance ?? 0),
      available: body?.is_available !== false,
      currency: info?.currency ?? "CNY",
      raw: body
    };
  },

  /**
   * @param {string} model
   * @param {number} timeMs
   */
  priceAt(model, timeMs) {
    return priceAt(model, timeMs);
  },

  /**
   * @param {TokenUsage} usage
   * @param {PriceUnit} unit
   */
  costOf(usage, unit) {
    return costOf(usage, unit, "CNY");
  },

  /**
   * 仅官方平台数据：未配置 DEEPSEEK_PLATFORM_TOKEN 时返回 null（不显示"今日消费"行）。
   * 余额差估算会受充值/退款影响，不再作为展示口径，避免统计混淆。
   * @param {HostContext} ctx
   * @param {{timezone?: string}=} config
   * @param {unknown} _balance
   * @returns {Promise<{consumed: number, source: string}|null>}
   */
  async todayConsumed(ctx, config = {}, _balance = undefined) {
    const tokenHit = await ctx.credentials?.resolve(PLATFORM_TOKEN_REF);
    if (tokenHit === undefined || tokenHit === null || typeof tokenHit.value !== "string") return null;
    try {
      const official = await fetchPlatformTodayCost(tokenHit.value, config.timezone ?? DEEPSEEK_ACCOUNTING_TIMEZONE);
      if (official !== null) return { consumed: official, source: "official" };
    } catch (err) {
      try {
        ctx.logger?.warn("dsh-billing-glass: platform usage fetch failed; today row hidden");
        ctx.logger?.warn(err);
      } catch { /* logger 不可用时静默 */ }
    }
    return null;
  },

  /**
   * 定价校验：拉官方定价页，解析现行价/峰谷表/生效日期并与内置政策链对比。
   * 报告 status: current（已同步）| changed（发现差异）| unavailable（页面
   * 结构变化无法解析）。changed/unavailable 时页面快照落盘到 storages，
   * 供助手后续分析更新政策链。
   * @param {HostContext} ctx
   * @returns {Promise<{status: string, details: string[], checkedAt?: number, pageHash?: string|null, source?: string, message?: string}>}
   */
  async refreshPricing(ctx) {
    const response = await fetch(PRICING_PAGE_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-billing-glass/0.1",
        Accept: "text/html"
      },
      signal: AbortSignal.timeout(20000)
    });
    const html = await response.text();
    if (!response.ok) {
      const error = new Error(`DeepSeek 定价页返回 HTTP ${response.status}`);
      /** @type {Error & {code?: string}} */ (error).code = "provider";
      throw error;
    }
    const report = compareWithBuiltin(parseOfficialPage(html));
    if (report.status !== "current") {
      try {
        mkdirSync(storagesPath(ctx), { recursive: true });
        const tmp = join(storagesPath(ctx), `${PRICING_SNAPSHOT_FILE}.tmp`);
        writeFileSync(tmp, html, "utf8");
        renameSync(tmp, join(storagesPath(ctx), PRICING_SNAPSHOT_FILE));
      } catch {}
    }
    // 页面内容指纹：即使解析成功，hash 变化也说明官方页有改动（审计用）。
    let pageHash = null;
    try {
      pageHash = createHash("sha256").update(html).digest("hex").slice(0, 12);
    } catch {}
    return { ...report, pageHash, source: "官方定价页" };
  }
};
