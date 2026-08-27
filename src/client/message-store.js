// 逐条消息费用角标的数据源（浏览器内存 external store + 账本路由刷新）。
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

let ledgerSeq = 0;
let ledgerAbort = /** @type {AbortController|null} */ (null);

/** @param {string} sessionId */
export async function refreshLedger(sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return;
	const seq = ++ledgerSeq;
	ledgerAbort?.abort();
	const controller = new AbortController();
	ledgerAbort = controller;
	try {
		const res = await fetch(`/api/billing-glass/ledger?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store", signal: controller.signal });
		const body = await res.json();
		if (seq !== ledgerSeq) return; // 旧请求不得覆盖新 session 的数据
		if (body !== null && typeof body === "object" && body.ok === true && Array.isArray(body.messages)) {
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
	}
}
