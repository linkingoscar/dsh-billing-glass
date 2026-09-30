import { formatMoney, formatTokens } from "./format.js";

/** Describe the stored message snapshot, never the current price catalog.
 * @param {any} record
 */
export function messageCostPresentation(record) {
  const unpriced = record.priced === false;
  const currency = record.nativeCurrency ?? record.currency ?? "USD";
  const amount = Number.isFinite(record.costNative) ? record.costNative : Number.isFinite(record.cost) ? record.cost : 0;
  if (unpriced) return {
    unpriced, label: "未计价",
    detail: `暂无可用定价，费用未计入（模型或定价日历可能缺失） · 模型 ${record.model ?? "unknown"}`
  };
  const snapshot = record.pricingSnapshot;
  const mode = snapshot?.mode === "peak" ? "高峰" : snapshot?.mode === "offPeak" ? "谷价" : snapshot?.mode === "flat" ? "固定单价" : "时段未记录";
  const source = typeof snapshot?.source === "string" && snapshot.source !== ""
    ? `首次计价来源 ${snapshot.source} · ${mode}` : "历史价格来源未记录";
  const rates = currency === "CNY" ? snapshot?.cny : currency === "USD" ? snapshot?.usd : null;
  const rateText = rates && [rates.input, rates.cacheRead, rates.output].every(Number.isFinite)
    ? `每百万 token ${currency}：输入 ${rates.input} / 缓存 ${rates.cacheRead} / 输出 ${rates.output}` : null;
  const label = `≈${formatMoney(amount, currency)}`;
  return { unpriced, label, detail: [
    `本地估算 ${formatMoney(amount, currency)}，非官方账单`, source, rateText,
    `输入 ${formatTokens(record.inputTokens)}`, `缓存 ${formatTokens(record.cacheReadTokens)}`,
    `输出 ${formatTokens(record.outputTokens)}`, record.model ? `模型 ${record.model}` : null
  ].filter(Boolean).join(" · ") };
}
