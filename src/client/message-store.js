// 逐条消息费用角标的数据源（浏览器内存 store + 账本路由刷新）。
		// ---- per-message cost store（逐条消息角标数据源）----------------
		export const messageCostStore = new Map(); // sessionId -> Map<messageId, record>

		export async function refreshLedger(sessionId) {
			if (typeof sessionId !== "string" || sessionId === "") return;
			try {
				const res = await fetch(`/api/billing-glass/ledger?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
				const body = await res.json();
				if (body !== null && typeof body === "object" && body.ok === true && Array.isArray(body.messages)) {
					const map = new Map();
					for (const m of body.messages) {
						if (m !== null && typeof m === "object" && typeof m.messageId === "string") map.set(m.messageId, m);
					}
					messageCostStore.set(sessionId, map);
				}
			} catch { /* 角标静默失败，不打断主卡 */ }
		}
