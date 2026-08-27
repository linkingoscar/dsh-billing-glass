// 主悬浮卡组件（胶囊态 + 展开态）。
import { useState, useEffect, useLayoutEffect, useCallback, useRef, jsx, jsxs, Fragment } from "./runtime.js";
import { POLL_MS, STATE_PATH, POS_KEY, COLLAPSED_KEY, CARD_W, BOTTOM_CLAMP_OFFSET } from "./constants.js";
import { currencySymbol, formatMoney, formatTokens, formatTime, clamp, loadPos, loadCollapsed } from "./format.js";
import { modelBadgeFor } from "./model-badge.js";
import { injectStyles, glass, sheen, glassButton, RefreshIcon, InfoIcon, TokenBar } from "./visuals.js";
import { refreshLedger } from "./message-store.js";
import { loadPrefs, subscribePrefs } from "./prefs.js";

/** state 路由响应里的供应商行（/api/billing-glass/state providers[i]）。
 * @typedef {{id: string, displayName: string, currency: string, isConfiguredProvider?: boolean, keyConfigured?: boolean|null, refreshSupported?: boolean, plan?: {kind: string, label: string}|null, rateMode?: string|null, balance?: {total: number, granted?: number, toppedUp?: number, available?: boolean}|null, balanceError?: string|null, session?: any|null, today?: {consumed: number, source: string}|null}} ProviderRow
 */
/** state 路由响应体（本插件使用面）。
 * @typedef {{ok: true, sessionId?: string, activeProvider?: string|null, activeModel?: string|null, configuredProvider?: string|null, configuredModel?: string|null, unrecognized?: {provider: string|null, baseUrl: string|null, model: string|null}|null, fxCnyPerUsd?: number, summary?: {today: SummaryBucketView, month: SummaryBucketView, total: SummaryBucketView}|null, ledgerHealth?: {degraded?: boolean, invalidLines?: number, recoveredTail?: number}|null, pricingCatalog?: {source:string,version:string}|null, providers?: ProviderRow[]}} BillingState
 */
/** 消费统计桶（客户端视图：原生分组 + USD 基准）。
 * @typedef {{costUsd?: number, native?: Record<string, number>, calls?: number, unpricedCalls?: number, inputTokens?: number, cacheReadTokens?: number, outputTokens?: number}} SummaryBucketView
 */
/** 定价校验结果状态。
 * @typedef {{status: string, message?: string|null, details: string[], pending?: boolean, checkedAt?: number}} RefreshStateView
 */
/** 指针拖拽会话的起点快照。
 * @typedef {{startX: number, startY: number, baseX: number, baseY: number}} DragStart
 */

		// ---- the widget -------------------------------------------------
		/**
		 * @param {{useSessions?: unknown}} props
		 */
		export function BillingGlassCard(props) {
			const useSessions = props.useSessions;
			const [state, setState] = useState(/** @type {BillingState|null} */ (null));
			const [phase, setPhase] = useState("loading"); // loading | ready | error
			const [message, setMessage] = useState("");
			const [updatedAt, setUpdatedAt] = useState(/** @type {Date|null} */ (null));
			const [spinning, setSpinning] = useState(false);
			const [collapsed, setCollapsed] = useState(loadCollapsed);
			const [pos, setPos] = useState(loadPos);
			const [tipOpen, setTipOpen] = useState(false);
			const [viewId, setViewId] = useState(/** @type {string|null} */ (null)); // null = 自动跟随现行供应商
			const [refreshState, setRefreshState] = useState(/** @type {RefreshStateView|null} */ (null)); // 定价校验结果
			const [showExtra, setShowExtra] = useState(false); // 展开其它官方供应商
			const [prefs, setPrefs] = useState(loadPrefs); // 显示偏好（设置卡片可改）
			useEffect(() => subscribePrefs(setPrefs), []);

			// 视口尺寸（渲染期读取；stub 环境兜底）。
			const vw = typeof window !== "undefined" && Number.isFinite(window.innerWidth) ? window.innerWidth : 1200;
			const vh = typeof window !== "undefined" && Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
			const mounted = useRef(true);
			const drag = useRef(/** @type {DragStart|null} */ (null));
			const posRef = useRef(pos);
			const loadSeqRef = useRef(0);
			const loadAbortRef = useRef(/** @type {AbortController|null} */ (null));
			useEffect(() => { posRef.current = pos; }, [pos]);

			const currentSessionId = typeof useSessions === "function" ? useSessions((/** @type {{current?: string}} */ s) => s.current) : void 0;

			useEffect(() => { injectStyles(); }, []);

			const load = useCallback(async () => {
				const seq = ++loadSeqRef.current;
				loadAbortRef.current?.abort();
				const controller = new AbortController();
				loadAbortRef.current = controller;
				setSpinning(true);
				try {
					const params = new URLSearchParams();
					if (typeof currentSessionId === "string" && currentSessionId !== "") {
						params.set("sessionId", currentSessionId);
					}
					try {
						params.set("tz", Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local");
					} catch {}
					const qs = params.toString();
					const res = await fetch(qs ? `${STATE_PATH}?${qs}` : STATE_PATH, { cache: "no-store", signal: controller.signal });
					let body = null;
					try { body = await res.json(); } catch {}
					if (!mounted.current || seq !== loadSeqRef.current) return;
					if (!res.ok || body === null || typeof body !== "object" || body.ok !== true) {
						const m = body && typeof body.message === "string" ? body.message : `请求失败（HTTP ${res.status}）`;
						setPhase("error");
						setMessage(m);
						return;
					}
					setState(body);
					setPhase("ready");
					setMessage("");
					setUpdatedAt(new Date());
					// 顺带刷新当前会话的逐条消息账本（角标数据）。
					if (typeof currentSessionId === "string" && currentSessionId !== "") {
						refreshLedger(currentSessionId);
					}
				} catch (error) {
					if (error !== null && typeof error === "object" && /** @type {{name?: string}} */ (error).name === "AbortError") return;
					if (!mounted.current || seq !== loadSeqRef.current) return;
					setPhase("error");
					setMessage(error instanceof Error ? error.message : String(error));
				} finally {
					if (mounted.current && seq === loadSeqRef.current) {
						setSpinning(false);
						if (loadAbortRef.current === controller) loadAbortRef.current = null;
					}
				}
			}, [currentSessionId]);

			useEffect(() => {
				mounted.current = true;
				load();
				const timer = setInterval(() => load(), POLL_MS);
				const onWindowFocus = () => { if (document.visibilityState === "visible") load(); };
				const onVisibilityChange = () => { if (document.visibilityState === "visible") load(); };
				window.addEventListener("focus", onWindowFocus);
				document.addEventListener("visibilitychange", onVisibilityChange);
				return () => {
					mounted.current = false;
					clearInterval(timer);
					loadAbortRef.current?.abort();
					window.removeEventListener("focus", onWindowFocus);
					document.removeEventListener("visibilitychange", onVisibilityChange);
				};
			}, [load, currentSessionId]);

			// ---- 派生值（必须在引用它们的 hooks 之前声明，避免 TDZ）-------
			const providers = state && Array.isArray(state.providers) ? state.providers : [];
			const activeId = state?.activeProvider;
			const activeModel = typeof state?.activeModel === "string" ? state.activeModel : null;
			// 主显示供应商：手动点选 > 会话实际使用 > 后台配置现行 > 注册表第一位（DeepSeek 优先）。
			const autoId = activeId ?? state?.configuredProvider ?? (providers[0]?.id ?? null);
			const primaryId = viewId ?? autoId;
			const primary =
				providers.find((p) => p.id === primaryId) ??
				providers.find((p) => p.id === autoId) ??
				providers[0] ?? null;
			const manualView = viewId !== null;
			/** @type {Record<string, string>} */
			const rateLabels = { flat: "标准价", peak: "峰时价", offPeak: "谷时价" };
			const rateLabel = primary && primary.rateMode !== undefined && primary.rateMode !== null
				? rateLabels[primary.rateMode] ?? null
				: null;
			// 消费统计展示：单币种且与当前供应商一致 → 原生精确合计（无换算）；
			// 混合币种 → 按 USD 基准 × 官方隐含汇率换算成当前供应商币种（标 ≈）。
			const fxCnyPerUsd = state !== null && Number.isFinite(state.fxCnyPerUsd) && /** @type {number} */ (state.fxCnyPerUsd) > 0 ? /** @type {number} */ (state.fxCnyPerUsd) : 7.2;
			/**
			 * @param {SummaryBucketView|undefined|null} bucket
			 * @returns {string}
			 */
			const summaryMoney = (bucket) => {
				const currency = primary ? primary.currency : "USD";
				const native = bucket?.native ?? null;
				if (native !== null && typeof native === "object") {
				 const filled = Object.entries(native).filter(([, value]) => value > 0);
				 if (filled.length === 1 && filled[0][0] === currency) {
					 return formatMoney(filled[0][1], currency);
				 }
				 if (filled.length === 0) return formatMoney(0, currency);
				}
				const formatted = formatMoney((bucket?.costUsd ?? 0) * (currency === "CNY" ? fxCnyPerUsd : 1), currency);
				return currency === "CNY" ? `≈${formatted}` : formatted;
			};

			// 手动刷新余额：走 POST 强刷路由（有外部副作用，不用 GET）。
			const refreshBalance = useCallback(async () => {
				const target = providers.find((p) => p.id === primaryId);
				if (!target) return false;
				try {
					const res = await fetch(`/api/billing-glass/refresh-balance?providerId=${encodeURIComponent(target.id)}`, { method: "POST", cache: "no-store" });
					let body = null;
					try { body = await res.json(); } catch {}
					if (!mounted.current) return false;
					if (!res.ok || body === null || typeof body !== "object" || body.ok !== true) {
						setPhase("error");
						setMessage(body && typeof body.message === "string" ? body.message : `强刷余额失败（HTTP ${res.status}）`);
						return false;
					}
					return true;
				} catch (error) {
					if (!mounted.current) return false;
					setPhase("error");
					setMessage(error instanceof Error ? error.message : String(error));
					return false;
				}
			}, [providers, primaryId]);

			// 校验当前供应商定价是否与官方同步（只刷当前显示的那家）。
			const refreshPricing = useCallback(async () => {
				const target = providers.find((p) => p.id === primaryId);
				if (!target || !target.refreshSupported) return;
				setRefreshState({ status: "pending", pending: true, details: [] });
				try {
					const res = await fetch(`/api/billing-glass/refresh-pricing?providerId=${encodeURIComponent(target.id)}`, { method: "POST", cache: "no-store" });
					let body = null;
					try { body = await res.json(); } catch {}
					if (!mounted.current) return;
					if (!res.ok || body === null || typeof body !== "object" || body.ok !== true) {
						setRefreshState({
							status: "unavailable",
							message: body && typeof body.message === "string" ? body.message : `请求失败（HTTP ${res.status}）`,
							details: []
						});
						return;
					}
					setRefreshState({
						status: body.status ?? "unavailable",
						message: body.message ?? null,
						details: Array.isArray(body.details) ? body.details : [],
						checkedAt: body.checkedAt ?? Date.now()
					});
					// 结果 10 秒后自动消失（也可手动点 ✕ 关闭）。
					setTimeout(() => {
						if (mounted.current) setRefreshState(null);
					}, 10000);
				} catch (error) {
					if (!mounted.current) return;
					setRefreshState({
						status: "unavailable",
						message: error instanceof Error ? error.message : String(error),
						details: []
					});
				}
			}, [providers, primaryId]);

			// 切换供应商/会话时清掉上一次校验结果。
			useEffect(() => {
				setRefreshState(null);
			}, [primaryId, currentSessionId]);

			// 拖拽（整卡可拖：4px 阈值区分点击与拖动；按卡片实测尺寸 clamp，
			// 头部永不会被拖出视口，贴顶/贴边都无空气墙）。
			const cardRef = useRef(/** @type {any} */ (null));
			const [cardSize, setCardSize] = useState({ w: CARD_W, h: 320 });
			// useLayoutEffect：DOM 更新后、浏览器绘制前同步测量，
			// 高度进 state 触发同步重渲染——paint 前位置已校正，无可见闪动。
			useLayoutEffect(() => {
				const el = cardRef.current;
				if (el && typeof el.offsetHeight === "number") {
					const w = el.offsetWidth || CARD_W;
					const h = el.offsetHeight || 320;
					if (w !== cardSize.w || h !== cardSize.h) setCardSize({ w, h });
				}
			});
			const dragMovedRef = useRef(false);
			/**
			 * @param {{button?: number, target?: any, currentTarget?: {setPointerCapture?: (id: number) => void}, pointerId?: number, clientX: number, clientY: number}} event
			 */
			const onPointerDown = (event) => {
				if (event.button !== 0) return;
				const t = event.target;
				if (t && typeof t.closest === "function" && t.closest("button, [role='button'], a, input")) return;
				event.currentTarget?.setPointerCapture?.(/** @type {number} */ (event.pointerId));
				dragMovedRef.current = false;
				drag.current = { startX: event.clientX, startY: event.clientY, baseX: pos.right, baseY: pos.bottom };
			};
			/**
			 * @param {{clientX: number, clientY: number}} event
			 */
			const onPointerMove = (event) => {
				const d = drag.current;
				if (!d) return;
				const dx = event.clientX - d.startX;
				const dy = event.clientY - d.startY;
				if (!dragMovedRef.current && Math.hypot(dx, dy) < 4) return;
				dragMovedRef.current = true;
				const nextRight = clamp(d.baseX - dx, 8, Math.max(8, vw - CARD_W - 8));
				const nextBottom = clamp(d.baseY - dy, BOTTOM_CLAMP_OFFSET, Math.max(BOTTOM_CLAMP_OFFSET, vh - cardSize.h - 8));
				setPos({ right: nextRight, bottom: nextBottom });
			};
			const onPointerUp = () => {
				drag.current = null;
				try { localStorage.setItem(POS_KEY, JSON.stringify(posRef.current)); } catch {}
			};
			const dragProps = { onPointerDown, onPointerMove, onPointerUp };

			const modelBadge = activeModel !== null && primary
				? modelBadgeFor(primary, activeModel)
				: null;

			const toggleCollapsed = () => {
				const next = !collapsed;
				setCollapsed(next);
				try { localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0"); } catch {}
				// 展开时立即拉取最新数据，避免先看到上一次轮询的旧余额。
				if (!next) load();
			};

			const dotColor =
				phase === "error"
					? "var(--dsw-alias-state-error-primary)"
					: primary && primary.balance && primary.balance.available === false
						? "var(--dsw-alias-state-error-primary)"
						: "var(--dsw-alias-state-success-primary)";

			const Dot = () => jsx("span", {
				"aria-hidden": true,
				style: {
					flex: "none", width: 8, height: 8, borderRadius: "50%",
					background: phase === "loading" ? "var(--dsw-alias-label-secondary)" : dotColor,
					boxShadow: `0 0 6px ${dotColor}`
				}
			});

			const balanceValue = primary && primary.balance && Number.isFinite(primary.balance.total)
				? formatMoney(primary.balance.total, primary.currency)
				: phase === "loading" ? "…" : "—";

			// ---- collapsed capsule --------------------------------------
			// 胶囊同样可拖动：按下移动超过 4px 判定为拖动，否则视为点击展开。
			// 左侧贴边需要胶囊实际宽度（估算宽度会在左边留空隙）。
			const capsuleRef = useRef(/** @type {any} */ (null));
			const capsuleWidthRef = useRef(180);
			useEffect(() => {
				if (capsuleRef.current && typeof capsuleRef.current.offsetWidth === "number") {
					capsuleWidthRef.current = capsuleRef.current.offsetWidth || 180;
				}
			});
			const capsuleDrag = useRef(/** @type {DragStart|null} */ (null));
			const capsuleMovedRef = useRef(false);
			/**
			 * @param {{button?: number, currentTarget?: {setPointerCapture?: (id: number) => void}, pointerId?: number, clientX: number, clientY: number}} event
			 */
			const capsulePointerDown = (event) => {
				if (event.button !== 0) return;
				event.currentTarget?.setPointerCapture?.(/** @type {number} */ (event.pointerId));
				capsuleMovedRef.current = false;
				capsuleDrag.current = { startX: event.clientX, startY: event.clientY, baseX: pos.right, baseY: pos.bottom };
			};
			/**
			 * @param {{clientX: number, clientY: number}} event
			 */
			const capsulePointerMove = (event) => {
				const d = capsuleDrag.current;
				if (!d) return;
				const dx = event.clientX - d.startX;
				const dy = event.clientY - d.startY;
				if (!capsuleMovedRef.current && Math.hypot(dx, dy) < 4) return;
				capsuleMovedRef.current = true;
				const nextRight = clamp(d.baseX - dx, 8, Math.max(8, window.innerWidth - capsuleWidthRef.current - 8));
				const nextBottom = clamp(d.baseY - dy, 8, Math.max(8, window.innerHeight - 44));
				setPos({ right: nextRight, bottom: nextBottom });
			};
			const capsulePointerUp = () => {
				const moved = capsuleMovedRef.current;
				capsuleDrag.current = null;
				if (moved) {
					try { localStorage.setItem(POS_KEY, JSON.stringify(posRef.current)); } catch {}
				}
			};
			const capsuleClick = () => {
				if (capsuleMovedRef.current) { capsuleMovedRef.current = false; return; }
				toggleCollapsed();
			};

			// 设置卡片里关掉胶囊：整体不渲染（回到设置页可重新打开）。
			// 此分支位于所有 hooks 之后，符合 React Hooks 规则。
			if (prefs.capsule === false) return null;

			if (collapsed) {
				return jsx("div", {
					ref: capsuleRef,
					role: "button",
					tabIndex: 0,
					"aria-label": "展开计费与余额悬浮卡",
					title: "DeepSeek Harness 计费与余额（点击展开，按住拖动）",
					"data-plugin": "dsh-billing-glass",
					className: "dsh-glass",
					onPointerDown: capsulePointerDown,
					onPointerMove: capsulePointerMove,
					onPointerUp: capsulePointerUp,
					onClick: capsuleClick,
					onKeyDown: (/** @type {{key: string, preventDefault: () => void}} */ e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCollapsed(); } },
					style: {
						...glass,
						position: "absolute",
						right: pos.right,
						bottom: pos.bottom,
						zIndex: 30,
						pointerEvents: "auto",
						boxSizing: "border-box",
						borderRadius: 999,
						padding: "7px 12px",
						display: "flex",
						alignItems: "center",
						gap: 8,
						cursor: "grab",
						touchAction: "none",
						userSelect: "none",
						fontSize: 12,
						lineHeight: "18px",
						animation: "dsh-glass-fade-in .25s ease",
						fontVariantNumeric: "tabular-nums"
					},
					children: jsxs(Fragment, {
						children: [
							jsx(Dot, {}),
							state?.unrecognized
								? jsx("span", { "aria-label": "检测到未识别的供应商", style: { fontSize: 11 }, children: "⚠" })
								: null,
							jsx("span", { style: { fontWeight: 600 }, children: primary ? primary.displayName : "计费" }),
							jsx("span", { style: { fontWeight: 700 }, children: balanceValue }),
							modelBadge ? jsx("span", {
								style: {
									fontSize: 9, lineHeight: "14px", padding: "0 5px", borderRadius: 999,
									maxWidth: 64, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
									background: "color-mix(in srgb, #5B9DFF 26%, transparent)",
									color: "var(--dsw-alias-label-secondary)", fontWeight: 600
								},
								children: modelBadge
							}) : null
						]
					})
				});
			}

			// ---- expanded glass card ------------------------------------
			// 位置在渲染期派生 clamp：展开卡比胶囊更宽更高，任何历史 pos
			//（如胶囊贴左边缘）都在第一帧就被校正为完全可见的位置——
			// 不再有"先越界一帧再跳回"的闪动。pos 本身保留胶囊语义，
			// 折叠回胶囊后仍停在原来的贴边位置。高度用实测 cardSize，
			// 贴顶贴边都不留空气墙。
			const cardPos = {
				right: clamp(pos.right, 8, Math.max(8, vw - CARD_W - 8)),
				bottom: clamp(pos.bottom, BOTTOM_CLAMP_OFFSET, Math.max(BOTTOM_CLAMP_OFFSET, vh - cardSize.h - 8))
			};
			const card = {
				...glass,
				position: "absolute",
				right: cardPos.right,
				bottom: cardPos.bottom,
				zIndex: 30,
				pointerEvents: "auto",
				boxSizing: "border-box",
				width: CARD_W,
				maxHeight: `calc(100vh - ${BOTTOM_CLAMP_OFFSET + 16}px)`,
				overflowX: "hidden",
				overflowY: "auto",
				scrollbarWidth: "thin",
				scrollbarColor: "color-mix(in srgb, #ffffff 25%, transparent) transparent",
				borderRadius: 16,
				padding: "10px 12px",
				display: "flex",
				flexDirection: "column",
				gap: 7,
				fontSize: 12,
				lineHeight: "18px",
				animation: "dsh-glass-fade-in .22s ease"
			};

			const headerRow = {
				display: "flex", alignItems: "center", gap: 6, height: 22,
				cursor: "grab", touchAction: "none"
			};

			const titleStyle = {
				flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6,
				fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
			};

			const session = primary && primary.session ? primary.session : null;
			const sessionCurrency = session?.nativeCurrency ?? primary?.currency ?? "USD";
			// 滚动升级兼容：新 host 给 costNative；旧 host 只有 cost（原生币种语义）。
			const sessionCostNative = Number.isFinite(session?.costNative)
				? session.costNative
				: Number.isFinite(session?.cost)
					? session.cost
					: (Number.isFinite(session?.costUsd) ? session.costUsd * (sessionCurrency === "CNY" ? 7.2 : 1) : 0);
			const breakdown = session && Array.isArray(session.breakdown) ? session.breakdown.filter((/** @type {{tokens?: number}} */ b) => b && typeof b === "object" && b.tokens !== undefined && b.tokens > 0) : [];
			// 只展示官方口径；旧 host 若返回 estimate 也直接隐藏，避免余额差估算误导。
			const today = primary && primary.today && primary.today.source === "official" ? primary.today : null;

			// 供应商列表：默认只显示"相关"的（当前显示 / 已配 Key / 有余额 / 后台现行），
			// 其余官方目录供应商折叠进一行，避免展开卡过长。
			const pinnedRows = providers.filter((/** @type {ProviderRow} */ p) =>
				p.id === primary.id || p.keyConfigured === true || p.balance !== null || p.isConfiguredProvider === true
			);
			/** @type {ProviderRow[]} */
			const extraRows = providers.filter((/** @type {ProviderRow} */ p) => !pinnedRows.includes(p));

			/**
			 * @param {ProviderRow} p
			 */
			const providerRow = (p) => jsxs("div", {
				role: "button",
				tabIndex: 0,
				"aria-label": `查看 ${p.displayName}`,
				title: p.id === primary.id && manualView ? "点击恢复自动跟随" : `查看 ${p.displayName} 详情`,
				onClick: () => { setViewId(viewId === p.id ? null : p.id); },
				onKeyDown: (/** @type {{key: string, preventDefault: () => void}} */ e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setViewId(viewId === p.id ? null : p.id); } },
				style: {
					display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
					fontSize: 11, lineHeight: "16px", fontVariantNumeric: "tabular-nums",
					borderRadius: 8, padding: "1px 6px", cursor: "pointer",
					background: p.id === primary.id ? "color-mix(in srgb, #5B9DFF 14%, transparent)" : "transparent"
				},
				children: [
					jsxs("span", {
						style: { flex: 1, display: "flex", alignItems: "center", gap: 5, minWidth: 0, overflow: "hidden", color: "var(--dsw-alias-label-secondary)" },
						children: [
							jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: p.displayName }),
							p.isConfiguredProvider
								? jsx("span", {
									style: { flex: "none", fontSize: 9, lineHeight: "13px", padding: "0 4px", borderRadius: 999, fontWeight: 600, color: "#4ADE80", background: "color-mix(in srgb, #4ADE80 14%, transparent)" },
									children: "现行"
								})
								: null,
							p.keyConfigured === false
								? jsx("span", { style: { flex: "none", fontSize: 9, lineHeight: "13px", color: "var(--dsw-alias-label-secondary)", opacity: 0.7 }, children: "未配置" })
								: null
						]
					}),
					jsx("span", {
						children: p.balanceError
							? "—"
							: p.balance ? formatMoney(p.balance.total, p.currency) : "—"
					})
				]
			}, p.id);

			return jsx("div", {
				ref: cardRef,
				role: "region",
				"aria-label": "计费与余额悬浮卡",
				"data-plugin": "dsh-billing-glass",
				className: "dsh-glass",
				style: card,
				...dragProps,
				children: jsxs(Fragment, {
					children: [
						jsx("div", { style: sheen }),
						jsxs("div", {
							style: headerRow,
							children: [
								jsx(Dot, {}),
								jsx("span", { style: titleStyle, children: primary ? primary.displayName + " 计费" : "计费与余额" }),
								modelBadge ? jsx("span", {
									style: {
										fontSize: 9, lineHeight: "14px", padding: "0 5px", borderRadius: 999,
										background: "color-mix(in srgb, #5B9DFF 26%, transparent)",
										color: "var(--dsw-alias-label-secondary)", fontWeight: 600
									},
									children: modelBadge
								}) : null,
								jsx("button", {
									type: "button",
									style: glassButton,
									"aria-label": "刷新计费与余额",
									title: "刷新",
									disabled: spinning,
									onPointerDown: (/** @type {{stopPropagation: () => void}} */ e) => { e.stopPropagation(); },
									onClick: async () => { await refreshBalance(); load(); },
									children: jsx(RefreshIcon, { spinning })
								}),
								jsx("button", {
									type: "button",
									style: glassButton,
									"aria-label": "折叠为胶囊",
									title: "折叠",
									onPointerDown: (/** @type {{stopPropagation: () => void}} */ e) => { e.stopPropagation(); },
									onClick: toggleCollapsed,
									children: jsx("svg", {
										width: 12, height: 12, viewBox: "0 0 16 16", fill: "none",
										children: jsx("path", {
											d: "M3 6l5 5 5-5", stroke: "currentColor", strokeWidth: 1.5,
											strokeLinecap: "round", strokeLinejoin: "round"
										})
									})
								})
							]
						}),
						phase === "error"
							? jsx("div", {
								style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 11, lineHeight: "16px", wordBreak: "break-all" },
								title: message,
								children: message
							})
							: jsxs(Fragment, {
								children: [
									jsxs("div", {
										style: { display: "flex", alignItems: "baseline", gap: 6 },
										children: [
											jsx("span", {
												style: {
													fontSize: 22, lineHeight: "28px", fontWeight: 700,
													fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap"
												},
												children: balanceValue
											}),
											primary && primary.balance
												? jsx("span", {
													style: {
														flex: "none", borderRadius: 999, padding: "0 6px",
														fontSize: 10, lineHeight: "16px",
														color: primary.balance.available === false
															? "var(--dsw-alias-state-error-primary)"
															: "var(--dsw-alias-state-success-primary)",
														background: "color-mix(in srgb, #ffffff 8%, transparent)"
													},
													children: primary.balance.available === false ? "不可用" : "可用"
												})
												: null
										]
									}),
									primary && primary.balanceError
										? jsx("div", {
											style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 10, lineHeight: "14px", wordBreak: "break-all" },
											children: primary.balanceError
										})
										: null,
									state?.unrecognized
										? jsx("div", {
											role: "alert",
											style: {
												display: "flex", gap: 6, alignItems: "flex-start",
												borderRadius: 10, padding: "6px 8px",
												border: "1px solid color-mix(in srgb, #F5A623 45%, transparent)",
												background: "color-mix(in srgb, #F5A623 12%, transparent)",
												fontSize: 10, lineHeight: "15px",
												color: "var(--dsw-alias-label-primary)"
											},
											children: jsxs(Fragment, {
												children: [
													jsx("span", { "aria-hidden": true, style: { flex: "none" }, children: "⚠" }),
													jsx("span", {
														children: `未识别的供应商 "${state.unrecognized.provider ?? state.unrecognized.baseUrl ?? "?"}"：不在 Harness 官方提供方列表中。请在对话中告诉助手它的计价方案（单价/套餐）或官方价格页链接，助手会帮你完成配置。`
													})
												]
											})
										})
										: null,
									state?.ledgerHealth?.degraded
										? jsx("div", {
											role: "status",
											style: {
												display: "flex", gap: 6, alignItems: "flex-start",
												borderRadius: 10, padding: "6px 8px",
												border: "1px solid color-mix(in srgb, #F5A623 45%, transparent)",
												background: "color-mix(in srgb, #F5A623 12%, transparent)",
												fontSize: 10, lineHeight: "15px",
												color: "var(--dsw-alias-label-primary)"
											},
											children: `⚠ 本地账本检测到损坏记录（无效行 ${state?.ledgerHealth?.invalidLines ?? 0}、尾部残行 ${state?.ledgerHealth?.recoveredTail ?? 0}），已跳过并修复文件`
										})
										: null,
									session
										? jsxs("div", {
											style: { display: "flex", alignItems: "center", gap: 4, fontWeight: 600, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
											children: [
												jsx("span", { style: { color: "var(--dsw-alias-label-secondary)", fontWeight: 400 }, children: "本会话费用" }),
												jsx("span", { children: formatMoney(sessionCostNative, sessionCurrency) }),
												jsx("span", {
													role: "button",
													tabIndex: 0,
													"aria-label": "查看计算公式",
													title: "查看计算公式",
													style: {
														flex: "none", display: "inline-flex", alignItems: "center",
														justifyContent: "center", width: 14, height: 14,
														borderRadius: "50%", color: "var(--dsw-alias-label-secondary)",
														cursor: "help", position: "relative"
													},
													onMouseEnter: () => { setTipOpen(true); },
													onMouseLeave: () => { setTipOpen(false); },
													onFocus: () => { setTipOpen(true); },
													onBlur: () => { setTipOpen(false); },
													children: jsx(InfoIcon, {})
												})
											]
										})
										: null,
									session && session.unpricedCalls > 0
										? jsx("div", {
											role: "status",
											style: {
												display: "flex", gap: 6, alignItems: "flex-start",
												borderRadius: 10, padding: "6px 8px",
												border: "1px solid color-mix(in srgb, #F5A623 45%, transparent)",
												background: "color-mix(in srgb, #F5A623 12%, transparent)",
												fontSize: 10, lineHeight: "15px",
												color: "var(--dsw-alias-label-primary)"
											},
											children: jsxs(Fragment, {
												children: [
													jsx("span", { "aria-hidden": true, style: { flex: "none" }, children: "⚠" }),
													jsx("span", {
														children: `${session.unpricedCalls} 条消息暂无价格（catalog 可能落后或模型改名），费用未计入`
													})
												]
											})
										})
										: null,
									tipOpen && breakdown.length > 0
										? jsx("div", {
											role: "tooltip",
											style: {
												...glass,
												position: "absolute",
												bottom: "calc(100% + 8px)",
												right: 0,
												zIndex: 40,
												width: 220,
												maxWidth: "calc(100vw - 32px)",
												borderRadius: 12,
												padding: "8px 10px",
												fontSize: 11,
												lineHeight: "18px",
												display: "flex",
												flexDirection: "column",
												gap: 2
											},
											children: jsxs(Fragment, {
												children: [
													jsx("div", { style: sheen }),
													jsx("div", { style: { fontWeight: 600, fontSize: 12, fontVariantNumeric: "tabular-nums" }, children: `本会话费用 = ${formatMoney(sessionCostNative, sessionCurrency)}` }),
													...breakdown.map((/** @type {{label: string, tokens: number, rate: number, subtotal: number}} */ b) => jsxs("div", {
														style: { display: "flex", justifyContent: "space-between", gap: 8, fontVariantNumeric: "tabular-nums" },
														children: [
															jsx("span", { style: { color: "var(--dsw-alias-label-secondary)" }, children: b.label }),
															jsx("span", { style: { whiteSpace: "nowrap" }, children: `${formatTokens(b.tokens)} tok × ${currencySymbol(sessionCurrency)}${b.rate}/M = ${formatMoney(b.subtotal, sessionCurrency)}` })
														]
													}, b.label)),
													jsx("div", {
														style: {
															color: "var(--dsw-alias-label-secondary)", fontSize: 10,
															borderTop: "1px solid color-mix(in srgb, #ffffff 10%, transparent)",
															paddingTop: 4, marginTop: 2
														},
														children: "本地估算；已落账消息固定采用首次计价快照"
													})
												]
											})
										})
										: null,
									session
										? jsxs("div", {
											style: { display: "flex", flexDirection: "column", gap: 3 },
											children: [
												jsx(TokenBar, { input: session.inputTokens, cacheRead: session.cacheReadTokens, output: session.outputTokens }),
												jsx("div", {
													style: {
														display: "flex", gap: 8, color: "var(--dsw-alias-label-secondary)",
														fontSize: 10, lineHeight: "14px", whiteSpace: "nowrap",
														fontVariantNumeric: "tabular-nums"
													},
													children: [
														jsx("span", { children: `输入 ${formatTokens(session.inputTokens)}` }),
														jsx("span", { children: `缓存 ${formatTokens(session.cacheReadTokens)}` }),
														jsx("span", { children: `输出 ${formatTokens(session.outputTokens)}` })
													]
												})
											]
										})
										: null,
									today
										? jsx("div", {
											style: {
												color: "var(--dsw-alias-label-secondary)", fontSize: 11,
												lineHeight: "16px", fontVariantNumeric: "tabular-nums"
											},
											children: `今日${today.source === "official" ? "已消费" : "约消费"} ${formatMoney(today.consumed, primary.currency)}`
										})
										: null,
									state?.summary
										? jsx("div", {
											title: "本机账本统计（单币种按原生金额精确显示；混合币种按官方隐含汇率换算，标 ≈）",
											style: {
												display: "flex", flexWrap: "nowrap", gap: 4, alignItems: "center",
												color: "var(--dsw-alias-label-secondary)", fontSize: 9,
												lineHeight: "14px", whiteSpace: "nowrap", overflow: "hidden",
												borderTop: "1px solid color-mix(in srgb, #ffffff 10%, transparent)",
												paddingTop: 4, fontVariantNumeric: "tabular-nums"
											},
											children: jsxs(Fragment, {
												children: [
													jsx("span", { style: { fontWeight: 600 }, children: "消费统计" }),
													(state?.summary?.total.unpricedCalls ?? 0) > 0
														? jsx("span", { style: { color: "#F5A623" }, children: `未计价${state?.summary?.total.unpricedCalls ?? 0}` })
														: null,
													jsx("span", { children: `今日${summaryMoney(state?.summary?.today)}` }),
													jsx("span", { children: "·" }),
													jsx("span", { children: `本月${summaryMoney(state?.summary?.month)}` }),
													jsx("span", { children: "·" }),
													jsx("span", { children: `累计${summaryMoney(state?.summary?.total)}` })
												]
											})
										})
										: null,
									primary && primary.plan
										? jsx("div", {
											style: {
												display: "flex", alignItems: "center", gap: 6,
												color: "var(--dsw-alias-label-secondary)", fontSize: 10,
												lineHeight: "14px", whiteSpace: "nowrap", overflow: "hidden"
											},
											children: jsxs(Fragment, {
												children: [
													jsx("span", {
														style: { flex: "none", borderRadius: 999, padding: "0 5px", lineHeight: "14px", fontWeight: 600, background: "color-mix(in srgb, #ffffff 8%, transparent)" },
														children: ({ token: "按量计费", subscription: "订阅套餐", credit: "额度制" })[primary.plan.kind] ?? "计费"
													}),
													jsx("span", { style: { overflow: "hidden", textOverflow: "ellipsis" }, children: primary.plan.label }),
													rateLabel ? jsx("span", {
														style: { flex: "none", borderRadius: 999, padding: "0 5px", lineHeight: "14px", fontWeight: 600, color: "#5B9DFF", background: "color-mix(in srgb, #5B9DFF 16%, transparent)" },
														children: rateLabel
													}) : null,
													primary.refreshSupported
														? jsx("button", {
															type: "button",
															style: {
																flex: "none", display: "inline-flex", alignItems: "center", gap: 3,
																border: "1px solid color-mix(in srgb, #ffffff 18%, transparent)",
																borderRadius: 999, padding: "0 6px", height: 16,
																fontSize: 9, lineHeight: "14px", fontWeight: 600,
																background: "color-mix(in srgb, #ffffff 8%, transparent)",
																color: "var(--dsw-alias-label-secondary)", cursor: "pointer"
															},
															"aria-label": `校验 ${primary.displayName} 定价是否与官方同步`,
															title: "拉取官方定价页，校验当前计费体系是否最新",
															disabled: refreshState?.pending === true,
															onClick: () => { refreshPricing(); },
															children: jsxs(Fragment, {
																children: [
																	jsx("span", {
																		style: refreshState?.pending ? { animation: "dsh-glass-spin 0.8s linear infinite" } : void 0,
																		children: "↻"
																	}),
																	jsx("span", { children: "校验定价" })
																]
															})
														})
														: null
												]
											})
										})
										: null,
									refreshState && refreshState.status !== "pending"
										? jsx("div", {
											role: "status",
											style: {
												display: "flex", flexDirection: "column", gap: 2,
												borderRadius: 8, padding: "4px 8px",
												border: `1px solid color-mix(in srgb, ${refreshState.status === "current" ? "#4ADE80" : refreshState.status === "changed" ? "#F5A623" : "#888"} 40%, transparent)`,
												background: `color-mix(in srgb, ${refreshState.status === "current" ? "#4ADE80" : refreshState.status === "changed" ? "#F5A623" : "#888"} 10%, transparent)`,
												fontSize: 10, lineHeight: "14px"
											},
											children: jsxs(Fragment, {
												children: [
													jsxs("div", {
														style: { display: "flex", alignItems: "flex-start", gap: 6 },
														children: [
															jsx("div", {
																style: { flex: 1, minWidth: 0, fontWeight: 600 },
																children: refreshState.status === "current"
																	? `✅ ${refreshState.message ?? "计费体系与官方同步"}`
																	: refreshState.status === "changed"
																		? `⚠ ${refreshState.message ?? "官方定价有变化"}`
																		: refreshState.message ?? "校验未完成"
															}),
															jsx("button", {
																type: "button",
																"aria-label": "关闭提示",
																title: "关闭（10 秒后也会自动消失）",
																onClick: () => { setRefreshState(null); },
																style: {
																	flex: "none", border: 0, padding: 0,
																	background: "transparent", cursor: "pointer",
																	color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "14px"
																},
																children: "✕"
															})
														]
													}),
													...(Array.isArray(refreshState.details) ? refreshState.details.slice(0, 2).map((d) => jsx("div", {
														style: { color: "var(--dsw-alias-label-secondary)", wordBreak: "break-all" },
														children: d
													}, String(d))) : [])
												]
											})
										})
										: null,
									providers.length > 1
										? jsx("div", {
											style: { display: "flex", flexDirection: "column", gap: 2, borderTop: "1px solid color-mix(in srgb, #ffffff 10%, transparent)", paddingTop: 5 },
											children: jsxs(Fragment, {
												children: [
													...pinnedRows.map((p) => providerRow(p)),
													extraRows.length > 0
														? jsx("button", {
															type: "button",
															"aria-label": showExtra ? "收起其它供应商" : `展开其它 ${extraRows.length} 家供应商`,
															onClick: () => { setShowExtra(!showExtra); },
															style: {
																display: "flex", alignItems: "center", gap: 4,
																alignSelf: "flex-start",
																border: 0, borderRadius: 6, padding: "0 4px",
																background: "transparent",
																color: "var(--dsw-alias-label-secondary)",
																fontSize: 10, lineHeight: "16px", cursor: "pointer"
															},
															children: jsxs(Fragment, {
																children: [
																	jsx("span", { children: showExtra ? "▾" : "▸" }),
																	jsx("span", { children: `其它官方供应商（${extraRows.length}）` })
																]
															})
														})
														: null,
													showExtra ? extraRows.map((p) => providerRow(p)) : null
												]
											})
										})
										: null,
									updatedAt
										? jsx("div", {
											style: {
												color: "var(--dsw-alias-label-secondary)", fontSize: 10,
												lineHeight: "14px", display: "flex", alignItems: "center", gap: 4,
												fontVariantNumeric: "tabular-nums"
											},
											children: [
												jsx("span", { children: `更新于 ${formatTime(updatedAt)}` }),
												jsx("span", { children: "·" }),
												jsx("span", { children: `本地估算 · ${state?.pricingCatalog?.source ?? "catalog"}@${state?.pricingCatalog?.version ?? "?"}` })
											]
										})
										: null
								]
							})
					]
				})
			});
		}
