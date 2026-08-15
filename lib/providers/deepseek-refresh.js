/**
 * DeepSeek 官方定价页解析与对比（纯函数，无依赖，可单测）。
 *
 * 数据源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/（Docusaurus SSR，
 * 文本结构规律）。解析现行价、峰谷表与生效日期，与内置政策链
 * （deepseek-pricing.js 的 OFFICIAL_PRICING_POLICIES）逐项对比，
 * 输出"是否与官方同步"的验证报告。
 *
 * 页面结构变化导致解析失败时返回 null——调用方引导用户通过对话告知助手。
 */
import { OFFICIAL_PRICING_POLICIES } from "./deepseek-pricing.js";

/** HTML → 纯文本（去 script/style/tag，折叠空白）。 */
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

/**
 * 解析官方定价页文本。
 * @returns {
 *   current: { [model]: { cacheRead, input, output } },   // 现行价（¥/1M）
 *   peak: { [model]: { offPeak: {..}, peak: {..} } },     // 峰谷价（¥/1M）
 *   effectiveAt: "YYYY-MM-DD" | null                      // 峰谷生效日期
 * } | null
 */
export function parseOfficialPage(html) {
  const text = htmlToText(html);
  if (!/百万\s*tokens/.test(text)) return null;

  const models = ["deepseek-v4-flash", "deepseek-v4-pro"];
  const current = {};
  const peak = {};

  for (const model of models) {
    // 现行价：模型段内 "价格 (1) ... 百万tokens输入（缓存命中） 0.02元 0.025元 ..."
    // 文本是转置布局：两个模型的数值依次出现在每行标签之后。
    // 取全局两处匹配（flash 在前、pro 在后）更稳健，这里按标签逐行提取成对数值。
    const cacheRow = new RegExp(`百万\\s*tokens\\s*输入\\s*（\\s*缓存\\s*命中\\s*）\\s*${YUAN}\\s*${YUAN}`, "g");
    const inputRow = new RegExp(`百万\\s*tokens\\s*输入\\s*（\\s*缓存\\s*未命中\\s*）\\s*${YUAN}\\s*${YUAN}`, "g");
    const outputRow = new RegExp(`百万\\s*tokens\\s*输出\\s*${YUAN}\\s*${YUAN}`, "g");
    const cacheMatch = [...text.matchAll(cacheRow)];
    const inputMatch = [...text.matchAll(inputRow)];
    const outputMatch = [...text.matchAll(outputRow)];
    if (cacheMatch.length < 1 || inputMatch.length < 1 || outputMatch.length < 1) return null;

    // 现行价取第一次出现的成对值（页面只有一组现行价表）。
    const [cacheRead, input, output] = [
      [cacheMatch[0][1], cacheMatch[0][2]],
      [inputMatch[0][1], inputMatch[0][2]],
      [outputMatch[0][1], outputMatch[0][2]]
    ].map((pair) => ({
      flash: Number(pair[0]),
      pro: Number(pair[1])
    }));

    const mine = model === "deepseek-v4-flash" ? cacheRead.flash : cacheRead.pro;
    current[model] = {
      cacheRead: mine,
      input: model === "deepseek-v4-flash" ? input.flash : input.pro,
      output: model === "deepseek-v4-flash" ? output.flash : output.pro
    };
  }

  // 峰谷表：按文档顺序收集（flash 空闲 → flash 高峰 → pro 空闲 → pro 高峰）。
  const offAll = [...text.matchAll(new RegExp(`空闲\\s*时段\\s*${YUAN}\\s*${YUAN}\\s*${YUAN}`, "g"))];
  const peakAll = [...text.matchAll(new RegExp(`高峰\\s*时段\\s*${YUAN}\\s*${YUAN}\\s*${YUAN}`, "g"))];
  if (offAll.length >= 2 && peakAll.length >= 2) {
    const toEntry = (m) => ({
      cacheRead: Number(m[1]),
      input: Number(m[2]),
      output: Number(m[3])
    });
    peak["deepseek-v4-flash"] = { offPeak: toEntry(offAll[0]), peak: toEntry(peakAll[0]) };
    peak["deepseek-v4-pro"] = { offPeak: toEntry(offAll[1]), peak: toEntry(peakAll[1]) };
  } else if (offAll.length >= 1 && peakAll.length >= 1) {
    // 页面只列了一个模型时，两个模型共用同一组峰谷价（保守降级）。
    const toEntry = (m) => ({
      cacheRead: Number(m[1]),
      input: Number(m[2]),
      output: Number(m[3])
    });
    const entry = { offPeak: toEntry(offAll[0]), peak: toEntry(peakAll[0]) };
    peak["deepseek-v4-flash"] = entry;
    peak["deepseek-v4-pro"] = entry;
  }

  if (Object.keys(current).length === 0) return null;

  let effectiveAt = null;
  const dateMatch = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (dateMatch) {
    effectiveAt = `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, "0")}-${String(dateMatch[3]).padStart(2, "0")}`;
  }

  return { current, peak, effectiveAt };
}

/** 从内置政策链取现行价与峰谷价（CNY）。 */
function builtinTables() {
  // 按 since 找政策，避免数组索引因新增 alias/历史条目而漂移。
  const flatPolicy = OFFICIAL_PRICING_POLICIES.find((p) => p.since === "2026-05-22T00:00:00+08:00");
  const peakPolicy = OFFICIAL_PRICING_POLICIES.find((p) => p.since === "2026-08-17T00:00:00+08:00");
  const models = ["deepseek-v4-flash", "deepseek-v4-pro"];
  const current = {};
  const peak = {};
  for (const model of models) {
    const flat = flatPolicy.prices[model];
    current[model] = { cacheRead: flat.cny.cacheRead, input: flat.cny.input, output: flat.cny.output };
    const on = peakPolicy.peak[model];
    const off = peakPolicy.offPeak[model];
    peak[model] = {
      offPeak: { cacheRead: off.cny.cacheRead, input: off.cny.input, output: off.cny.output },
      peak: { cacheRead: on.cny.cacheRead, input: on.cny.input, output: on.cny.output }
    };
  }
  return { current, peak, effectiveAt: peakPolicy.since.slice(0, 10) };
}

function fmt(v) {
  return Number.isFinite(v) ? `¥${v}/M` : "?";
}

/**
 * 对比官方页面解析结果与内置政策链。
 * @returns { status: "current"|"changed"|"unavailable", details: string[], checkedAt }
 */
export function compareWithBuiltin(parsed) {
  if (parsed === null || parsed === void 0) {
    return { status: "unavailable", details: ["无法解析官方定价页（页面结构可能已变化）"] };
  }
  const builtin = builtinTables();
  const details = [];
  const models = ["deepseek-v4-flash", "deepseek-v4-pro"];

  for (const model of models) {
    const cur = parsed.current?.[model];
    const builtCur = builtin.current[model];
    if (cur !== void 0) {
      for (const key of ["cacheRead", "input", "output"]) {
        if (cur[key] !== builtCur[key]) {
          details.push(`${model} 现行价 ${key}：内置 ${fmt(builtCur[key])} ≠ 官方 ${fmt(cur[key])}`);
        }
      }
    }
    const pk = parsed.peak?.[model];
    const builtPeak = builtin.peak[model];
    if (pk !== void 0) {
      for (const band of ["offPeak", "peak"]) {
        for (const key of ["cacheRead", "input", "output"]) {
          if (pk[band]?.[key] !== builtPeak[band][key]) {
            details.push(`${model} ${band === "peak" ? "高峰" : "空闲"} ${key}：内置 ${fmt(builtPeak[band][key])} ≠ 官方 ${fmt(pk[band][key])}`);
          }
        }
      }
    } else if (Object.keys(parsed.peak ?? {}).length > 0) {
      details.push(`${model} 峰谷价未能从官方页面解析`);
    }
  }

  if (parsed.effectiveAt !== null && builtin.effectiveAt !== parsed.effectiveAt) {
    details.push(`峰谷生效日期：内置 ${builtin.effectiveAt} ≠ 官方 ${parsed.effectiveAt}`);
  }

  if (details.length === 0) {
    return {
      status: "current",
      details: ["与官方定价页一致：现行价与峰谷价（含生效日期）均已同步"],
      checkedAt: Date.now()
    };
  }
  return { status: "changed", details, checkedAt: Date.now() };
}
