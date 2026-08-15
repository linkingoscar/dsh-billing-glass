// dsh-billing-glass — browser half.
//
// 液态玻璃（liquid-glass）计费悬浮卡，注册在框架级 `shell.overlay` 槽位：
//
//   - 常驻形态：右下角一枚小玻璃胶囊 —— 状态点 + 供应商 + 余额，一瞥即得，
//     点击展开完整玻璃卡；展开卡头部可拖动，位置存 localStorage。
//   - 玻璃材质：backdrop-filter 磨砂增艳 + 半透明主题底色 + 镜面高光描边 +
//     折射光斑层 + 柔和悬浮投影，自动跟随 --dsw-* 亮/暗主题。
//   - 展开卡内容（融合各家所长）：
//       * 余额大字 + 可用状态（dsh-deepseek-quota）
//       * 本会话费用 + ⓘ 计算公式 tooltip（dsh-deepseek-quota / dsh-web-billing）
//       * 今日消费估算（dsh-deepseek-quota）
//       * 输入/缓存/输出 token 三桶占比条与明细（dsh-spend / dsh-cost-meter）
//       * 多供应商余额列表，活跃供应商高亮（为接入其它 API 留余量）
//       * 计价政策（峰/谷/平）与更新时间
//   - 轮询 /api/billing-glass/state：DeepSeek 余额 10s（其它 60s），会话切换/聚焦/展开立即刷新。
window.__ModuleLoader__.load({
	id: "dsh-billing-glass",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		const { useState, useEffect, useLayoutEffect, useCallback, useRef } = react;
		const { jsx, jsxs, Fragment } = jsxRuntime;

		// ---- constants -------------------------------------------------
		const POLL_MS = 10 * 1000;
		const STATE_PATH = "/api/billing-glass/state";
		const POS_KEY = "dsh-billing-glass-pos";
		const COLLAPSED_KEY = "dsh-billing-glass-collapsed";
		const CARD_W = 252;
		// 底部导航/安全区高度：展开卡默认停在其上方，避免内容被遮挡。
		const BOTTOM_NAV_OFFSET = 72;

		// ---- one-shot style/keyframes injection --------------------------
		function injectStyles() {
			if (document.getElementById("dsh-billing-glass-styles")) return;
			const el = document.createElement("style");
			el.id = "dsh-billing-glass-styles";
			el.textContent = [
				"@keyframes dsh-glass-fade-in { from { opacity: 0; transform: translateY(10px) scale(.97); } to { opacity: 1; transform: none; } }",
				"@keyframes dsh-glass-spin { to { transform: rotate(360deg); } }",
				"@keyframes dsh-glass-shimmer { from { background-position: -140% 0; } to { background-position: 240% 0; } }",
				"@media (prefers-reduced-motion: reduce) { .dsh-glass *, .dsh-glass { animation: none !important; transition: none !important; } }"
			].join("\n");
			document.head.appendChild(el);
		}

		// ---- per-message cost store（逐条消息角标数据源）----------------
		const messageCostStore = new Map(); // sessionId -> Map<messageId, record>

		async function refreshLedger(sessionId) {
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

		// ---- small helpers ---------------------------------------------
		function currencySymbol(code) {
			switch (code) {
				case "CNY": return "¥";
				case "USD": return "$";
				case "EUR": return "€";
				case "JPY": return "¥";
				case "HKD": return "HK$";
				default: return code ? `${code} ` : "";
			}
		}

		function formatMoney(value, currency) {
			const symbol = currencySymbol(currency);
			if (!Number.isFinite(value) || value <= 0) return `${symbol}0`;
			if (value >= 100) return `${symbol}${value.toFixed(0)}`;
			if (value >= 1) return `${symbol}${value.toFixed(2)}`;
			if (value >= 0.01) return `${symbol}${value.toFixed(3)}`;
			return `${symbol}${value.toPrecision(2)}`;
		}

		function formatTokens(value) {
			return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}

		/** 根据供应商与模型名生成一个简短型号代称（如 DeepSeek Pro/Flash、K2.5、5.6-Sol、Opus-4）。 */
		function modelBadgeFor(provider, model) {
			if (typeof model !== "string" || model === "") return null;
			const text = model;
			const lower = text.toLowerCase();
			const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

			const isDeepSeek = provider?.id === "deepseek" || lower.includes("deepseek");
			if (isDeepSeek) {
				if (/(^|[^a-z0-9])pro([^a-z0-9]|$)/i.test(text)) return "Pro";
				if (/(^|[^a-z0-9])flash([^a-z0-9]|$)/i.test(text)) return "Flash";
			}

			// Kimi：kimi-k2.5 -> K2.5，kimi-k2.7-code -> K2.7-Code，kimi-k3 -> K3
			const kimi = lower.match(/kimi-?k?(\d+(?:\.\d+)?)(?:-([a-z0-9]+))?/);
			if (kimi) {
				const suffix = kimi[2];
				const suffixLabel = ({ code: "Code", thinking: "Think", turbo: "Turbo", preview: "Preview", highspeed: "HighSpeed" })[suffix];
				return `K${kimi[1]}${suffixLabel ? `-${suffixLabel}` : ""}`;
			}

			// GPT：gpt-5.6-luna -> 5.6-Luna，gpt-5.2-pro -> 5.2-Pro，gpt-4o -> 4o
			if (lower.includes("gpt")) {
				const gpt = lower.match(/gpt[-/]?(\d+(?:\.\d+)?o?)(?:[-/]([a-z0-9]+))?/);
				if (gpt) {
					const version = gpt[1];
					const variant = gpt[2];
					const variantLabel = variant ? cap(variant) : null;
					if (variant && ["sol", "tera", "luna", "lunar"].includes(variant)) return `${version}-${variantLabel}`;
					const knownVariant = ({ turbo: "Turbo", mini: "Mini", pro: "Pro", nano: "Nano", max: "Max", codex: "Codex", audio: "Audio", chat: "Chat", oss: "OSS", latest: "Latest" })[variant];
					if (knownVariant) return `${version}-${knownVariant}`;
					return version;
				}
				if (/\bgpt-oss\b/i.test(text)) return "OSS";
				if (/\bgpt-audio\b/i.test(text)) return "Audio";
				if (/\bgpt-chat\b/i.test(text)) return "Chat";
			}

			// Claude：claude-opus-4 -> Opus-4，claude-haiku-4.5 -> Haiku-4.5
			if (lower.includes("claude")) {
				const tier = text.match(/(opus|sonnet|haiku|fable)/i)?.[1];
				const version = text.match(/claude[^0-9]*(\d+(?:\.\d+)?)/i)?.[1];
				const tierLabel = tier ? cap(tier) : "Claude";
				return version ? `${tierLabel}-${version}` : tierLabel;
			}

			// Gemini：gemini-2.5-pro -> 2.5-Pro，gemini-3-flash -> 3-Flash
			if (lower.includes("gemini")) {
				const version = text.match(/gemini[-/]?(\d+(?:\.\d+)?)/i)?.[1];
				const tier = text.match(/(pro|flash|lite)/i)?.[1];
				const tierLabel = tier ? cap(tier) : null;
				if (version && tierLabel) return `${version}-${tierLabel}`;
				if (version) return version;
				return tierLabel ?? "Gemini";
			}

			// Qwen：qwen3.7-max -> 3.7-Max，qwen-plus -> Plus
			if (lower.includes("qwen")) {
				const version = text.match(/qwen[-/]?(\d+(?:\.\d+)?)/i)?.[1];
				const tier = text.match(/(max|plus|pro|flash|lite|turbo|coder|thinking|vl)/i)?.[1];
				const tierLabel = tier ? (tier === "vl" ? "VL" : cap(tier)) : null;
				if (version && tierLabel) return `${version}-${tierLabel}`;
				if (version) return version;
				return tierLabel ?? "Qwen";
			}

			// GLM：glm-5.2 -> 5.2，glm-4.7-flash -> 4.7-Flash
			if (lower.includes("glm")) {
				const version = text.match(/glm[-/]?(\d+(?:\.\d+)?)/i)?.[1];
				const variant = text.match(/(air|flash|turbo|plus|pro|v)/i)?.[1];
				const variantLabel = variant ? (variant === "v" ? "V" : cap(variant)) : null;
				if (version && variantLabel) return `${version}-${variantLabel}`;
				if (version) return version;
				return variantLabel ?? "GLM";
			}

			const tiers = [
				["pro", "Pro"], ["flash", "Flash"], ["lite", "Lite"], ["mini", "Mini"],
				["nano", "Nano"], ["max", "Max"], ["ultra", "Ultra"], ["turbo", "Turbo"],
				["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"],
				["thinking", "Thinking"], ["code", "Code"], ["preview", "Preview"]
			];
			for (const [token, label] of tiers) {
				if (new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(text)) return label;
			}
			const series = [
				["kimi", "Kimi"], ["glm", "GLM"], ["qwen", "Qwen"], ["gpt", "GPT"],
				["gemini", "Gemini"], ["gemma", "Gemma"], ["claude", "Claude"],
				["llama", "Llama"], ["mistral", "Mistral"], ["mixtral", "Mistral"],
				["ministral", "Mistral"], ["codestral", "Mistral"], ["devstral", "Mistral"],
				["voxtral", "Mistral"], ["grok", "Grok"], ["mimo", "MiMo"],
				["minimax", "MM"], ["nemotron", "Nemo"], ["deepseek", "DeepSeek"],
				["ling", "Ling"], ["ring", "Ring"], ["step", "Step"],
				["north", "North"], ["laguna", "Laguna"], ["seed", "Seed"],
				["nova", "Nova"], ["command", "Command"], ["jamba", "Jamba"],
				["granite", "Granite"], ["inkling", "Inkling"], ["auto", "Auto"],
				["hy3", "Hunyuan"], ["solar", "Solar"], ["mercury", "Mercury"],
				["aion", "Aion"], ["muse", "Muse"], ["trinity", "Trinity"],
				["virtuoso", "Virtuoso"], ["kat", "Kat"], ["longcat", "LongCat"],
				["free", "Free"]
			];
			for (const [token, label] of series) {
				if (new RegExp(`(^|[^a-z0-9])${token}([^a-z0-9]|$)`, "i").test(text)) return label;
			}
			return null;
		}

		function formatTime(date) {
			const hh = String(date.getHours()).padStart(2, "0");
			const mm = String(date.getMinutes()).padStart(2, "0");
			const ss = String(date.getSeconds()).padStart(2, "0");
			return `${hh}:${mm}:${ss}`;
		}

		function clamp(value, min, max) {
			return Math.min(max, Math.max(min, value));
		}

		function loadPos() {
			try {
				const parsed = JSON.parse(localStorage.getItem(POS_KEY) ?? "null");
				if (parsed && typeof parsed === "object" && Number.isFinite(parsed.right) && Number.isFinite(parsed.bottom)) {
					return { right: parsed.right, bottom: parsed.bottom };
				}
			} catch {}
			return { right: 16, bottom: 16 };
		}

		function loadCollapsed() {
			try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
		}

		// ---- glass materials -------------------------------------------
		const glass = {
			background: "color-mix(in srgb, var(--dsw-alias-bg-overlay) 52%, transparent)",
			WebkitBackdropFilter: "blur(22px) saturate(1.8)",
			backdropFilter: "blur(22px) saturate(1.8)",
			border: "1px solid color-mix(in srgb, #ffffff 26%, transparent)",
			boxShadow:
				"0 16px 48px rgba(0, 0, 0, 0.30), 0 3px 12px rgba(0, 0, 0, 0.16), " +
				"inset 0 1px 0 rgba(255, 255, 255, 0.32), inset 0 -1px 0 rgba(255, 255, 255, 0.06)",
			color: "var(--dsw-alias-label-primary)"
		};

		const sheen = {
			position: "absolute",
			inset: 0,
			borderRadius: "inherit",
			pointerEvents: "none",
			background:
				"radial-gradient(130% 90% at 18% 0%, rgba(255,255,255,0.14), rgba(255,255,255,0.03) 40%, transparent 62%)"
		};

		const glassButton = {
			flex: "none",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 22,
			height: 22,
			border: "1px solid color-mix(in srgb, #ffffff 18%, transparent)",
			borderRadius: 7,
			padding: 0,
			background: "color-mix(in srgb, #ffffff 8%, transparent)",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer"
		};

		// ---- tiny visuals ----------------------------------------------
		function RefreshIcon({ spinning }) {
			return jsx("svg", {
				width: 13, height: 13, viewBox: "0 0 16 16", fill: "none",
				style: spinning ? { animation: "dsh-glass-spin 0.8s linear infinite" } : void 0,
				children: jsx("path", {
					d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3",
					stroke: "currentColor", strokeWidth: 1.5,
					strokeLinecap: "round", strokeLinejoin: "round"
				})
			});
		}

		function InfoIcon() {
			return jsx("svg", {
				width: 13, height: 13, viewBox: "0 0 16 16", fill: "none",
				children: jsxs(Fragment, {
					children: [
						jsx("circle", { cx: 8, cy: 8, r: 6.5, stroke: "currentColor", strokeWidth: 1.3 }),
						jsx("path", { d: "M8 5v3.6", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
						jsx("circle", { cx: 8, cy: 11.2, r: 0.9, fill: "currentColor" })
					]
				})
			});
		}

		/** 输入/缓存/输出三桶占比条（玻璃细条）。 */
		function TokenBar({ input, cacheRead, output }) {
			const total = input + cacheRead + output;
			if (total <= 0) return null;
			const seg = (color, flex) => ({
				height: 3, borderRadius: 999, background: color,
				flex, minWidth: flex > 0.02 ? 2 : 0, transition: "flex 0.3s ease"
			});
			return jsx("div", {
				"aria-hidden": true,
				style: {
					display: "flex", gap: 2, overflow: "hidden", borderRadius: 999,
					background: "color-mix(in srgb, #ffffff 10%, transparent)", padding: 1
				},
				children: jsxs(Fragment, {
					children: [
						jsx("div", { style: seg("#5B9DFF", input / total) }),
						jsx("div", { style: seg("#4ADE80", cacheRead / total) }),
						jsx("div", { style: seg("#C084FC", output / total) })
					]
				})
			});
		}

		// ---- the widget -------------------------------------------------
		function BillingGlassCard(props) {
			const useSessions = props.useSessions;
			const [state, setState] = useState(null);
			const [phase, setPhase] = useState("loading"); // loading | ready | error
			const [message, setMessage] = useState("");
			const [updatedAt, setUpdatedAt] = useState(null);
			const [spinning, setSpinning] = useState(false);
			const [collapsed, setCollapsed] = useState(loadCollapsed);
			const [pos, setPos] = useState(loadPos);
			const [tipOpen, setTipOpen] = useState(false);
			const [viewId, setViewId] = useState(null); // null = 自动跟随现行供应商
			const [refreshState, setRefreshState] = useState(null); // 定价校验结果
			const [showExtra, setShowExtra] = useState(false); // 展开其它官方供应商

			// 视口尺寸（渲染期读取；stub 环境兜底）。
			const vw = typeof window !== "undefined" && Number.isFinite(window.innerWidth) ? window.innerWidth : 1200;
			const vh = typeof window !== "undefined" && Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
			const mounted = useRef(true);
			const drag = useRef(null);
			const posRef = useRef(pos);
			useEffect(() => { posRef.current = pos; }, [pos]);

			const currentSessionId = typeof useSessions === "function" ? useSessions((s) => s.current) : void 0;

			useEffect(() => { injectStyles(); }, []);

			const load = useCallback(async (force = false, providerId = null) => {
				setSpinning(true);
				try {
					const params = new URLSearchParams();
					if (typeof currentSessionId === "string" && currentSessionId !== "") {
						params.set("sessionId", currentSessionId);
					}
					if (force) {
						params.set("force", "1");
						if (providerId) params.set("providerId", providerId);
					}
					const qs = params.toString();
					const res = await fetch(qs ? `${STATE_PATH}?${qs}` : STATE_PATH, { cache: "no-store" });
					let body = null;
					try { body = await res.json(); } catch {}
					if (!mounted.current) return;
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
					if (!mounted.current) return;
					setPhase("error");
					setMessage(error instanceof Error ? error.message : String(error));
				} finally {
					if (mounted.current) setSpinning(false);
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
			const rateLabel = primary
				? ({ flat: "标准价", peak: "峰时价", offPeak: "谷时价" })[primary.rateMode] ?? null
				: null;
			// 账本 USD 汇总 → 当前供应商币种换算显示。
			const usdRate = primary && primary.currency === "CNY" ? 7.2 : 1;
			const summaryMoney = (bucket) => formatMoney((bucket?.costUsd ?? 0) * usdRate, primary ? primary.currency : "USD");

			// 校验当前供应商定价是否与官方同步（只刷当前显示的那家）。
			const refreshPricing = useCallback(async () => {
				const target = providers.find((p) => p.id === primaryId);
				if (!target || !target.refreshSupported) return;
				setRefreshState({ status: "pending", pending: true, details: [] });
				try {
					const res = await fetch(`/api/billing-glass/refresh-pricing?providerId=${encodeURIComponent(target.id)}`, { cache: "no-store" });
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
			const cardRef = useRef(null);
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
			const onPointerDown = (event) => {
				if (event.button !== 0) return;
				const t = event.target;
				if (t && typeof t.closest === "function" && t.closest("button, [role='button'], a, input")) return;
				event.currentTarget.setPointerCapture?.(event.pointerId);
				dragMovedRef.current = false;
				drag.current = { startX: event.clientX, startY: event.clientY, baseX: pos.right, baseY: pos.bottom };
			};
			const onPointerMove = (event) => {
				const d = drag.current;
				if (!d) return;
				const dx = event.clientX - d.startX;
				const dy = event.clientY - d.startY;
				if (!dragMovedRef.current && Math.hypot(dx, dy) < 4) return;
				dragMovedRef.current = true;
				const nextRight = clamp(d.baseX - dx, 8, Math.max(8, vw - CARD_W - 8));
				const nextBottom = clamp(d.baseY - dy, BOTTOM_NAV_OFFSET, Math.max(BOTTOM_NAV_OFFSET, vh - cardSize.h - 8));
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
			const capsuleRef = useRef(null);
			const capsuleWidthRef = useRef(180);
			useEffect(() => {
				if (capsuleRef.current && typeof capsuleRef.current.offsetWidth === "number") {
					capsuleWidthRef.current = capsuleRef.current.offsetWidth || 180;
				}
			});
			const capsuleDrag = useRef(null);
			const capsuleMovedRef = useRef(false);
			const capsulePointerDown = (event) => {
				if (event.button !== 0) return;
				event.currentTarget.setPointerCapture?.(event.pointerId);
				capsuleMovedRef.current = false;
				capsuleDrag.current = { startX: event.clientX, startY: event.clientY, baseX: pos.right, baseY: pos.bottom };
			};
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
					onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCollapsed(); } },
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
				bottom: clamp(pos.bottom, BOTTOM_NAV_OFFSET, Math.max(BOTTOM_NAV_OFFSET, vh - cardSize.h - 8))
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
				maxHeight: `calc(100vh - ${BOTTOM_NAV_OFFSET + 16}px)`,
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
			const breakdown = session && Array.isArray(session.breakdown) ? session.breakdown.filter((b) => b && typeof b === "object" && b.tokens > 0) : [];
			const today = primary && primary.today ? primary.today : null;

			// 供应商列表：默认只显示"相关"的（当前显示 / 已配 Key / 有余额 / 后台现行），
			// 其余官方目录供应商折叠进一行，避免展开卡过长。
			const pinnedRows = providers.filter((p) =>
				p.id === primary.id || p.keyConfigured === true || p.balance !== null || p.isConfiguredProvider === true
			);
			const extraRows = providers.filter((p) => !pinnedRows.includes(p));

			const providerRow = (p) => jsxs("div", {
				role: "button",
				tabIndex: 0,
				"aria-label": `查看 ${p.displayName}`,
				title: p.id === primary.id && manualView ? "点击恢复自动跟随" : `查看 ${p.displayName} 详情`,
				onClick: () => { setViewId(viewId === p.id ? null : p.id); },
				onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setViewId(viewId === p.id ? null : p.id); } },
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
									onPointerDown: (e) => { e.stopPropagation(); },
									onClick: () => { load(true, primary ? primary.id : null); },
									children: jsx(RefreshIcon, { spinning })
								}),
								jsx("button", {
									type: "button",
									style: glassButton,
									"aria-label": "折叠为胶囊",
									title: "折叠",
									onPointerDown: (e) => { e.stopPropagation(); },
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
									session
										? jsxs("div", {
											style: { display: "flex", alignItems: "center", gap: 4, fontWeight: 600, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
											children: [
												jsx("span", { style: { color: "var(--dsw-alias-label-secondary)", fontWeight: 400 }, children: "本会话费用" }),
												jsx("span", { children: formatMoney(session.cost, primary.currency) }),
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
													jsx("div", { style: { fontWeight: 600, fontSize: 12, fontVariantNumeric: "tabular-nums" }, children: `本会话费用 = ${formatMoney(session.cost, primary.currency)}` }),
													...breakdown.map((b) => jsxs("div", {
														style: { display: "flex", justifyContent: "space-between", gap: 8, fontVariantNumeric: "tabular-nums" },
														children: [
															jsx("span", { style: { color: "var(--dsw-alias-label-secondary)" }, children: b.label }),
															jsx("span", { style: { whiteSpace: "nowrap" }, children: `${formatTokens(b.tokens)} tok × ¥${b.rate}/M = ${formatMoney(b.subtotal, primary.currency)}` })
														]
													}, b.label)),
													jsx("div", {
														style: {
															color: "var(--dsw-alias-label-secondary)", fontSize: 10,
															borderTop: "1px solid color-mix(in srgb, #ffffff 10%, transparent)",
															paddingTop: 4, marginTop: 2
														},
														children: "按消息时刻官方价格表计价（含峰谷）"
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
											title: "本机账本统计（按消息时刻计价，USD 汇总后按当前供应商币种换算）",
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
													jsx("span", { children: `今日${summaryMoney(state.summary.today)}` }),
													jsx("span", { children: "·" }),
													jsx("span", { children: `本月${summaryMoney(state.summary.month)}` }),
													jsx("span", { children: "·" }),
													jsx("span", { children: `累计${summaryMoney(state.summary.total)}` })
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
												jsx("span", { children: "整卡可拖动 · 点击折叠" })
											]
										})
										: null
								]
							})
					]
				})
			});
		}

		// ---- per-message cost chip（conversation.chat.assistant-actions）---
		function MessageCostChip({ messageId, sessionId }) {
			if (typeof messageId !== "string" || typeof sessionId !== "string") return null;
			const map = messageCostStore.get(sessionId);
			const record = map ? map.get(messageId) : void 0;
			if (record === void 0) return null;
			const symbol = currencySymbol(record.currency);
			const label = formatMoney(record.cost, record.currency);
			const detail = [
				`输入 ${formatTokens(record.inputTokens)}`,
				`缓存 ${formatTokens(record.cacheReadTokens)}`,
				`输出 ${formatTokens(record.outputTokens)}`,
				record.model ? `模型 ${record.model}` : null
			].filter(Boolean).join(" · ");
			return jsx("span", {
				"data-plugin": "dsh-billing-glass",
				title: `${symbol}${detail}`,
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
					border: "1px solid color-mix(in srgb, #ffffff 16%, transparent)",
					background: "color-mix(in srgb, #5B9DFF 10%, transparent)",
					color: "var(--dsw-alias-label-secondary)"
				},
				children: label
			});
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "billing-glass",
				order: 100,
				label: "计费与余额"
			}, BillingGlassCard));
			ctx.slots.inject("conversation.chat.assistant-actions", () => ctx.slots.register({
				name: "conversation.chat.assistant-actions",
				id: "billing-glass-cost",
				order: 20,
				label: "本消息费用"
			}, MessageCostChip));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
