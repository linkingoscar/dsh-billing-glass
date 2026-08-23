/**
 * Provider 注册表 —— 多供应商扩展点。
 *
 * 一个 provider 是一个纯模块，导出 `defineProvider({...})` 结果：
 *
 *   {
 *     id: "deepseek",              // 稳定标识（路由/配置键）
 *     displayName: "DeepSeek",     // 悬浮卡显示名
 *     currency: "CNY",             // 计费主币种（ISO 4217）
 *     aliases: ["deepseek-official"], // 归属匹配：Harness provider id 别名
 *     baseUrlHosts: ["api.deepseek.com"], // 归属匹配：pi-ai 网关 baseURL 的 hostname
 *     defaultModel: "deepseek-v4-pro",
 *     keyRef: "DEEPSEEK_API_KEY",  // 凭证引用名（判断该供应商是否已配置 Key）
 *
 *     // 套餐 / 费用体系描述（悬浮卡"套餐"行展示）
 *     plan: {
 *       kind: "token",             // "token"=按量计费 | "subscription"=订阅套餐
 *       label: "按量计费（官方价格政策，含峰谷）",
 *       // 订阅制额外字段：fee、currency、period、quotaLabel
 *     },
 *
 *     // 余额：返回 null 表示该供应商不支持余额查询
 *     fetchBalance: async (ctx, config) => ({
 *       total: 12.34, granted: 1.0, toppedUp: 11.34, available: true
 *     }),
 *
 *     // 计价：某模型某时刻的单价（双币种，¥/$ 每 1M tokens）。
 *     // 模型未知且无兜底价时必须返回 null（fail closed，禁止按 0 计费）。
 *     priceAt: (model, timeMs) => ({
 *       cny: { input, cacheRead, output },
 *       usd: { input, cacheRead, output },
 *       mode: "flat" | "peak" | "offPeak"
 *     }) | null,
 *
 *     // 计价金额：costNative 用供应商原生币种（nativeCurrency），
 *     // costUsd 是跨供应商聚合的唯一基准；不再返回模糊的 cost。
 *     costOf: (usage, unit) => ({ costNative, nativeCurrency, costUsd, ...tokens }),
 *
 *     // 可选：今日消费（无官方用量接口时可用余额差估算）
 *     todayConsumed: async (ctx, config, balance) => number | null,
 *   }
 *
 * 新增供应商 = 新增 `lib/providers/<vendor>.js` + 在下方 PROVIDERS 注册，
 * 悬浮卡与聚合路由自动多出一节，无需改动 UI 与 host 主逻辑。
 */

import { deepseek } from "./deepseek.js";
import { catalogProviders } from "./openai-compat.js";

/** @import { ProviderContract } from "../types.js" */

/** DeepSeek 专用（精确峰谷政策链）打头，官方目录预置供应商随其后。
 * @type {ProviderContract[]}
 */
export const PROVIDERS = [deepseek, ...catalogProviders()];

/**
 * 按 id 查找 provider。
 * @param {string} id
 * @returns {ProviderContract|undefined}
 */
export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id);
}

/** 归一化 Harness 的 provider id（含别名）。
 * @param {unknown} headerProvider
 * @returns {ProviderContract|null}
 */
function matchByProviderId(headerProvider) {
  if (typeof headerProvider !== "string" || headerProvider === "") return null;
  for (const p of PROVIDERS) {
    if (p.id === headerProvider) return p;
    if (Array.isArray(p.aliases) && p.aliases.includes(headerProvider)) return p;
  }
  return null;
}

/** 按 pi-ai 网关的 baseURL hostname 匹配供应商。
 * @param {unknown} baseUrl
 * @returns {ProviderContract|null}
 */
function matchByBaseUrlHost(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl === "") return null;
  let host;
  try { host = new URL(baseUrl).hostname; } catch { return null; }
  const bare = host.toLowerCase().replace(/^www\./, "");
  for (const p of PROVIDERS) {
    if (Array.isArray(p.baseUrlHosts)) {
      for (const h of p.baseUrlHosts) {
        if (bare === h || bare.endsWith("." + h)) return p;
      }
    }
  }
  return null;
}

/**
 * 会话/配置里的供应商归属匹配（两级：provider id 别名 > baseURL hostname）。
 * @param {unknown} headerProvider - Harness 的 provider id（如 `deepseek-official`、`pi-ai`）
 * @param {unknown} baseUrl - 请求的 baseURL（pi-ai 网关用，OpenAI 兼容端点）
 * @returns {ProviderContract|null}
 */
export function matchProvider(headerProvider, baseUrl) {
  return matchByProviderId(headerProvider) ?? matchByBaseUrlHost(baseUrl);
}
