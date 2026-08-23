/**
 * DeepSeek 官方定价页解析与对比（纯函数，无依赖，可单测）。
 *
 * 数据源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/（Docusaurus SSR，
 * 文本结构规律）。2026-08 起页面为单一峰谷矩阵：模型列（flash / pro /
 * vision-exp…）× 指标行（缓存命中/未命中/输出）× 时段行（空闲/高峰），
 * 不再有独立"现行价"表。解析结果与内置政策链
 * （deepseek-pricing.js 的 OFFICIAL_PRICING_POLICIES）逐项对比，
 * 输出"是否与官方同步"的验证报告。
 *
 * 页面结构变化导致解析失败时返回 null——调用方引导用户通过对话告知助手。
 */
import { OFFICIAL_PRICING_POLICIES } from "./deepseek-pricing.js";

/** HTML → 纯文本（去 script/style/tag，折叠空白）。
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#0*160;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const NUM = String.raw`(\d+(?:\.\d+)?)`;
const YUAN = String.raw`${NUM}\s*元`;

/** 已知模型列的官方顺序；解析时只取页面头部实际出现的子集。 */
const KNOWN_MODEL_ORDER = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp"
];

/**
 * 单指标某时段的三元组（缓存命中/未命中输入、输出单价，¥/1M tokens）。
 * @typedef {{cacheRead: number, input: number, output: number}} PriceTriple
 */

/** 官方页解析结果（峰谷矩阵）。
 * @typedef {object} ParsedPricingPage
 * @property {Record<string, {offPeak: PriceTriple, peak: PriceTriple}>} peak 按模型的峰谷价。
 * @property {string|null} effectiveAt 页面声明的生效日期（可空）。
 */

/** n 个连续的「X元」捕获组。
 * @param {number} n
 * @returns {string}
 */
function priceGroup(n) {
  return Array.from({ length: n }, () => YUAN).join("\\s*");
}

/** 指标行的匹配模式：标签 + 空闲时段 N 列 + 高峰时段 N 列。
 * @param {string} labelPattern
 * @param {number} columnCount
 * @returns {string}
 */
function metricRowPattern(labelPattern, columnCount) {
  return `${labelPattern}\\s*空闲\\s*时段\\s*${priceGroup(columnCount)}\\s*高峰\\s*时段\\s*${priceGroup(columnCount)}`;
}

/** @type {{key: keyof PriceTriple, label: string}[]} */
const METRICS = [
  { key: "cacheRead", label: String.raw`百万\s*tokens\s*输入\s*[（(]\s*缓存\s*命中\s*[）)]` },
  { key: "input", label: String.raw`百万\s*tokens\s*输入\s*[（(]\s*缓存\s*未命中\s*[）)]` },
  { key: "output", label: String.raw`百万\s*tokens\s*输出` }
];

/**
 * 解析官方定价页文本（2026-08 峰谷矩阵布局）。
 * @param {string} html 原始 HTML。
 * @returns {ParsedPricingPage|null} 结构变化时返回 null（fail closed）。
 */
export function parseOfficialPage(html) {
  const text = htmlToText(html);
  if (!/百万\s*tokens/.test(text)) return null;

  // 列检测：定价表表头（首处 BASE URL 之前）按官方顺序出现的已知模型。
  const headEnd = text.indexOf("BASE URL");
  const headerRegion = headEnd === -1 ? text : text.slice(0, headEnd);
  const models = KNOWN_MODEL_ORDER.filter((m) => headerRegion.includes(m));
  if (!models.includes("deepseek-v4-flash")) return null;
  if (models.length < 1) return null;

  // 三个指标行各取第一处匹配；任一缺失即视为结构变化（fail closed）。
  /** @type {Record<string, {offPeak: number[], peak: number[]}>} */
  const values = {};
  for (const metric of METRICS) {
    const match = new RegExp(metricRowPattern(metric.label, models.length)).exec(text);
    if (match === null) return null;
    const cells = /** @type {RegExpExecArray} */ (match).slice(1).map(Number);
    values[metric.key] = {
      offPeak: cells.slice(0, models.length),
      peak: cells.slice(models.length)
    };
  }

  /** @type {ParsedPricingPage["peak"]} */
  const peak = {};
  for (let column = 0; column < models.length; column++) {
    const model = /** @type {string} */ (models[column]);
    peak[model] = {
      offPeak: /** @type {PriceTriple} */ (Object.fromEntries(METRICS.map(({ key }) => [key, values[key].offPeak[column]]))),
      peak: /** @type {PriceTriple} */ (Object.fromEntries(METRICS.map(({ key }) => [key, values[key].peak[column]])))
    };
  }

  let effectiveAt = null;
  const dateMatch = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (dateMatch) {
    effectiveAt = `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, "0")}-${String(dateMatch[3]).padStart(2, "0")}`;
  }

  return { peak, effectiveAt };
}

/** 从内置政策链取现行峰谷价（CNY），模型集以现行政策为准（含 vision-exp）。
 * @returns {{peak: Record<string, {offPeak: PriceTriple, peak: PriceTriple}>, effectiveAt: string}}
 */
function builtinTables() {
  // 按 since 找政策，避免数组索引因新增 alias/历史条目而漂移。
  const peakPolicy = OFFICIAL_PRICING_POLICIES.find((p) => p.since === "2026-08-17T00:00:00+08:00");
  if (peakPolicy === undefined || peakPolicy.peak === undefined || peakPolicy.offPeak === undefined) {
    throw new Error("builtin pricing policy chain is missing the active peak/valley policy");
  }
  /** @type {Record<string, {offPeak: PriceTriple, peak: PriceTriple}>} */
  const peak = {};
  for (const model of Object.keys(peakPolicy.peak)) {
    const on = peakPolicy.peak[model];
    const off = peakPolicy.offPeak[model];
    if (on === void 0 || off === void 0) continue;
    peak[model] = {
      offPeak: { cacheRead: off.cny.cacheRead, input: off.cny.input, output: off.cny.output },
      peak: { cacheRead: on.cny.cacheRead, input: on.cny.input, output: on.cny.output }
    };
  }
  return { peak, effectiveAt: peakPolicy.since.slice(0, 10) };
}

/** @param {number} v */
function fmt(v) {
  return Number.isFinite(v) ? `¥${v}/M` : "?";
}

/**
 * 对比官方页面解析结果与内置政策链。
 * @param {ParsedPricingPage|null|undefined} parsed
 * @returns {{status: "current"|"changed"|"unavailable", details: string[], checkedAt?: number}}
 */
export function compareWithBuiltin(parsed) {
  if (parsed === null || parsed === void 0) {
    return { status: "unavailable", details: ["无法解析官方定价页（页面结构可能已变化）"] };
  }
  const builtin = builtinTables();
  const details = [];

  for (const model of Object.keys(builtin.peak)) {
    const builtPeak = builtin.peak[model];
    const pk = parsed.peak?.[model];
    if (pk === void 0) {
      details.push(`${model} 峰谷价未能从官方页面解析`);
      continue;
    }
    /** @type {("offPeak"|"peak")[]} */
    const bands = ["offPeak", "peak"];
    for (const band of bands) {
      /** @type {("cacheRead"|"input"|"output")[]} */
      const keys = ["cacheRead", "input", "output"];
      for (const key of keys) {
        if (pk[band]?.[key] !== builtPeak[band][key]) {
          details.push(`${model} ${band === "peak" ? "高峰" : "空闲"} ${key}：内置 ${fmt(builtPeak[band][key])} ≠ 官方 ${fmt(pk[band]?.[key])}`);
        }
      }
    }
  }

  // 生效日期双侧都有才比较；新版页面可能不再声明日期。
  if (parsed.effectiveAt !== null && parsed.effectiveAt !== void 0 && builtin.effectiveAt !== parsed.effectiveAt) {
    details.push(`峰谷生效日期：内置 ${builtin.effectiveAt} ≠ 官方 ${parsed.effectiveAt}`);
  }

  if (details.length === 0) {
    return {
      status: "current",
      details: ["与官方定价页一致：峰谷价（含生效日期，如声明）均已同步"],
      checkedAt: Date.now()
    };
  }
  return { status: "changed", details, checkedAt: Date.now() };
}
