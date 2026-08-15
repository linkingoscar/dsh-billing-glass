/**
 * DeepSeek provider —— 默认供应商，注册表里排第一位（悬浮卡优先展示）。
 *
 * - 余额：官方 GET /user/balance（复用 DEEPSEEK_API_KEY 凭证，Key 不出本机）
 * - 今日消费：无官方用量接口时按余额差估算（`opening − current`，日状态落盘）
 * - 计价：官方价格政策链 + 峰谷时段（见 deepseek-pricing.js）
 *
 * 注意：本插件零外部运行时依赖（link:/git 安装即可用）。
 * `ctx.credentials.resolve` 接受纯字符串凭证引用
 * （@deepseek-ai/dsh-credentials 的 credentialRef 只是模式校验后原样返回）。
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { priceAt, costOf } from "./deepseek-pricing.js";
import { parseOfficialPage, compareWithBuiltin } from "./deepseek-refresh.js";

const PUBLIC_BASE_URL = "https://api.deepseek.com";
const BASE_URL_ENV = "DEEPSEEK_BASE_URL";
const CREDENTIAL_REF = "DEEPSEEK_API_KEY";
const PLATFORM_TOKEN_REF = "DEEPSEEK_PLATFORM_TOKEN";
const PLATFORM_USAGE_URL = "https://platform.deepseek.com/api/v0/usage/cost";
const PRICING_PAGE_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
const PRICING_SNAPSHOT_FILE = "billing-glass-pricing-snapshot.html";
const BALANCE_PATH = "/user/balance";
const TIMEOUT_MS = 15000;
const DAY_STATE_FILE = "billing-glass-day.json";

function balanceUrl() {
  const base = process.env[BASE_URL_ENV] ?? PUBLIC_BASE_URL;
  return `${base.replace(/\/+$/, "")}${BALANCE_PATH}`;
}

/** 本地日历日 `YYYY-MM-DD`。 */
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayStatePath(ctx) {
  let storages;
  const homeFn = typeof ctx?.get === "function" ? ctx.get("dshHomePath") : void 0;
  if (typeof homeFn === "function") {
    storages = homeFn("storages");
  } else if (process.env.DSH_HOME) {
    storages = join(process.env.DSH_HOME, "storages");
  } else {
    storages = join(homedir(), ".dsh", "storages");
  }
  return join(storages, DAY_STATE_FILE);
}

/** storages 目录路径（快照等持久化用）。 */
function storagesPath(ctx) {
  return dirname(dayStatePath(ctx));
}

function loadDayState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed !== null && typeof parsed === "object" &&
      typeof parsed.date === "string" &&
      typeof parsed.opening === "number" &&
      typeof parsed.last === "number"
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

function saveDayState(path, state) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, path);
  } catch {}
}

/** 余额差估算今日消费：`max(0, opening − current)`（分，四舍五入）。 */
function estimateTodayConsumed(ctx, balance) {
  if (!Number.isFinite(balance)) return null;
  const path = dayStatePath(ctx);
  const today = localDate();
  const stored = loadDayState(path);
  const opening =
    stored !== null && stored.date === today
      ? stored.opening
      : (stored !== null ? stored.last : balance);
  saveDayState(path, { date: today, opening, last: balance });
  const consumed = Math.max(0, opening - balance);
  return Math.round(consumed * 100) / 100;
}

/** 提取 DeepSeek 错误正文里的可读信息。 */
function providerMessage(text, status) {
  try {
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message;
    if (typeof message === "string" && message !== "") return message;
  } catch {}
  return `DeepSeek 接口返回 HTTP ${status}`;
}

// ---- 今日消费：官方平台数据（可选，配 DEEPSEEK_PLATFORM_TOKEN 时启用） ----

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

/** 拉官方平台今日消费（platform.deepseek.com 前端内部接口）。 */
async function fetchPlatformTodayCost(token) {
  const now = new Date();
  const url = `${PLATFORM_USAGE_URL}?month=${now.getMonth() + 1}&year=${now.getFullYear()}`;
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
  return parsePlatformTodayCost(await response.json());
}

export const deepseek = {
  id: "deepseek",
  displayName: "DeepSeek",
  currency: "CNY",
  aliases: ["deepseek-official"],
  baseUrlHosts: ["api.deepseek.com"],
  defaultModel: "deepseek-v4-pro",
  keyRef: "DEEPSEEK_API_KEY",
  plan: {
    kind: "token",
    label: "按量计费 · 官方价格政策（含峰谷时段）"
  },

  async fetchBalance(ctx) {
    const hit = await ctx.credentials.resolve(CREDENTIAL_REF);
    if (hit === void 0) {
      const error = new Error("未配置 DEEPSEEK_API_KEY：请在 设置 → 模型 中填写 DeepSeek API Key。");
      error.code = "no-api-key";
      throw error;
    }
    const response = await fetch(balanceUrl(), {
      headers: { Authorization: `Bearer ${hit.value}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(providerMessage(text, response.status));
      error.code = "provider";
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

  priceAt(model, timeMs) {
    return priceAt(model, timeMs);
  },

  costOf(usage, unit) {
    return costOf(usage, unit, "CNY");
  },

  async todayConsumed(ctx, config, balance) {
    // 优先：官方平台数据（需配置 DEEPSEEK_PLATFORM_TOKEN，见 README「官方今日消费」）。
    const tokenHit = await ctx.credentials.resolve(PLATFORM_TOKEN_REF);
    if (tokenHit !== void 0) {
      try {
        const official = await fetchPlatformTodayCost(tokenHit.value);
        if (official !== null) return { consumed: official, source: "official" };
      } catch (err) {
        try {
          ctx.logger?.warn("dsh-billing-glass: platform usage fetch failed; falling back to balance-delta estimate");
          ctx.logger?.warn(err);
        } catch { /* logger 不可用时静默 */ }
      }
    }
    // 回退：余额差估算（无 token / 官方接口失败 / 今天无行）。
    if (typeof balance?.total === "number") {
      const consumed = estimateTodayConsumed(ctx, balance.total);
      if (consumed !== null) return { consumed, source: "estimate" };
    }
    return null;
  },

  /**
   * 定价校验：拉官方定价页，解析现行价/峰谷表/生效日期并与内置政策链对比。
   * 报告 status: current（已同步）| changed（发现差异）| unavailable（页面
   * 结构变化无法解析）。changed/unavailable 时页面快照落盘到 storages，
   * 供助手后续分析更新政策链。
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
      error.code = "provider";
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
    return { ...report, source: "官方定价页" };
  }
};
