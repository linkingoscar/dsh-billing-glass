// 逐条消息费用角标的数据源（浏览器内存 external store + 账本路由刷新）。
import { POLL_MS } from "./constants.js";
/** @type {Map<string, Map<string, any>>} */
const messageCostStore = new Map(); // sessionId -> Map<messageId, record>
const MESSAGE_SESSION_MAX = 32;
/** @type {Set<() => void>} */
const listeners = new Set();

/** @param {() => void} listener */
export function subscribeMessageStore(listener) {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

/**
 * @param {unknown} sessionId
 * @param {unknown} messageId
 * @returns {any|undefined}
 */
export function readMessageCost(sessionId, messageId) {
	if (typeof sessionId !== "string" || typeof messageId !== "string") return void 0;
	return messageCostStore.get(sessionId)?.get(messageId);
}

function notify() {
	for (const listener of listeners) listener();
}

/** @type {Map<string, AbortController>} */
const ledgerRequests = new Map();
/** @type {Map<string, {count: number, timer: ReturnType<typeof setInterval>}>} */
const ledgerWatches = new Map();

/**
 * Share one ledger poll among all mounted message chips in a session.
 * @param {string} sessionId
 * @returns {() => void} Releases the poll and outstanding request after the last chip unmounts.
 */
export function watchMessageSession(sessionId) {
	let watch = ledgerWatches.get(sessionId);
	if (watch === undefined) {
		watch = { count: 0, timer: setInterval(() => { void refreshLedger(sessionId); }, POLL_MS) };
		ledgerWatches.set(sessionId, watch);
		void refreshLedger(sessionId);
	}
	watch.count++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (--watch.count !== 0) return;
		clearInterval(watch.timer);
		ledgerWatches.delete(sessionId);
		ledgerRequests.get(sessionId)?.abort();
		ledgerRequests.delete(sessionId);
	};
}

/** @param {string} sessionId */
export async function refreshLedger(sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return;
	// Concurrent main/sidebar sessions must not cancel each other's requests.
	if (ledgerRequests.has(sessionId)) return;
	const controller = new AbortController();
	ledgerRequests.set(sessionId, controller);
	try {
		const res = await fetch(`/api/billing-glass/ledger?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store", signal: controller.signal });
		const body = await res.json();
		if (controller.signal.aborted) return;
		if (res.ok && body !== null && typeof body === "object" && body.ok === true && Array.isArray(body.messages)) {
			const map = new Map();
			for (const m of body.messages) {
				if (m !== null && typeof m === "object" && typeof m.messageId === "string") map.set(m.messageId, m);
			}
			messageCostStore.delete(sessionId);
			messageCostStore.set(sessionId, map);
			while (messageCostStore.size > MESSAGE_SESSION_MAX) {
				const oldest = messageCostStore.keys().next().value;
				if (oldest === undefined) break;
				messageCostStore.delete(oldest);
			}
			notify();
		}
	} catch (error) {
		if (error !== null && typeof error === "object" && /** @type {{name?: string}} */ (error).name === "AbortError") return;
		/* 角标静默失败，不打断主卡 */
	} finally {
		if (ledgerRequests.get(sessionId) === controller) ledgerRequests.delete(sessionId);
	}
}
