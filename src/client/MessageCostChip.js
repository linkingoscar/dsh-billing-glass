// 逐条消息费用角标（订阅 messageCostStore，异步刷新后自动重渲染）。
import { jsx, useState, useEffect } from "./runtime.js";
import { currencySymbol, formatMoney, formatTokens } from "./format.js";
import { subscribeMessageStore, readMessageCost } from "./message-store.js";

export function MessageCostChip({ messageId, sessionId }) {
	if (typeof messageId !== "string" || typeof sessionId !== "string") return null;
	// external-store subscription：Map mutation 不会触发 React，这里显式订阅。
	const [, setTick] = useState(0);
	useEffect(() => subscribeMessageStore(() => setTick((t) => t + 1)), []);
	const record = readMessageCost(sessionId, messageId);
	if (record === void 0) return null;
	const unpriced = record.priced === false;
	const nativeCurrency = record.nativeCurrency ?? record.currency ?? "USD";
	const recordCostNative = Number.isFinite(record.costNative)
		? record.costNative
		: Number.isFinite(record.cost) ? record.cost : 0;
	const symbol = currencySymbol(nativeCurrency);
	const label = unpriced ? "未计价" : formatMoney(recordCostNative, nativeCurrency);
	const detail = unpriced
		? `暂无价格，费用未计入 · 模型 ${record.model ?? "unknown"}`
		: [
			`输入 ${formatTokens(record.inputTokens)}`,
			`缓存 ${formatTokens(record.cacheReadTokens)}`,
			`输出 ${formatTokens(record.outputTokens)}`,
			record.model ? `模型 ${record.model}` : null
		].filter(Boolean).join(" · ");
	return jsx("span", {
		"data-plugin": "dsh-billing-glass",
		title: unpriced ? detail : `${symbol}${detail}`,
		style: {
			display: "inline-flex",
			alignItems: "center",
			gap: 2,
			borderRadius: 999,
			padding: "0 6px",
			height: 16,
			fontSize: 10,
			lineHeight: "14px",
			fontVariantNumeric: "tabular-nums",
			border: unpriced
				? "1px solid color-mix(in srgb, #F5A623 45%, transparent)"
				: "1px solid color-mix(in srgb, #ffffff 16%, transparent)",
			background: unpriced
				? "color-mix(in srgb, #F5A623 14%, transparent)"
				: "color-mix(in srgb, #5B9DFF 10%, transparent)",
			color: unpriced ? "#F5A623" : "var(--dsw-alias-label-secondary)"
		},
		children: label
	});
}
