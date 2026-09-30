// 逐条消息费用角标（订阅 messageCostStore，异步刷新后自动重渲染）。
import { jsx, useState, useEffect } from "./runtime.js";
import { messageCostPresentation } from "./message-cost-detail.js";
import { subscribeMessageStore, readMessageCost, watchMessageSession } from "./message-store.js";
import { loadPrefs, subscribePrefs } from "./prefs.js";

/**
 * @param {{messageId?: unknown, sessionId?: unknown}} props
 */
export function MessageCostChip({ messageId, sessionId }) {
	// Hooks 必须在任何 early return 之前调用（React Hooks 规则）。
	const [, setTick] = useState(/** @type {number} */ (0));
	const [prefs, setPrefs] = useState(loadPrefs);
	useEffect(() => subscribeMessageStore(() => setTick((/** @type {number} */ t) => t + 1)), []);
	useEffect(() => subscribePrefs(setPrefs), []);
	useEffect(() => {
		if (prefs.costChip !== false && typeof sessionId === "string" && sessionId !== "") {
			return watchMessageSession(sessionId);
		}
	}, [sessionId, prefs.costChip]);
	if (prefs.costChip === false) return null;
	if (typeof messageId !== "string" || typeof sessionId !== "string") return null;
	const record = readMessageCost(sessionId, messageId);
	if (record === void 0) return null;
	const { unpriced, label, detail } = messageCostPresentation(record);
	return jsx("span", {
		"data-plugin": "dsh-billing-glass",
		title: detail,
		"aria-label": detail,
		tabIndex: 0,
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
