// 玻璃材质与小组件（注入样式、图标、token 三桶条）。
import { jsx, jsxs, Fragment } from "./runtime.js";
		// ---- one-shot style/keyframes injection --------------------------
		export function injectStyles() {
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

		// ---- glass materials -------------------------------------------
		export const glass = {
			background: "color-mix(in srgb, var(--dsw-alias-bg-overlay) 52%, transparent)",
			WebkitBackdropFilter: "blur(22px) saturate(1.8)",
			backdropFilter: "blur(22px) saturate(1.8)",
			border: "1px solid color-mix(in srgb, #ffffff 26%, transparent)",
			boxShadow:
				"0 16px 48px rgba(0, 0, 0, 0.30), 0 3px 12px rgba(0, 0, 0, 0.16), " +
				"inset 0 1px 0 rgba(255, 255, 255, 0.32), inset 0 -1px 0 rgba(255, 255, 255, 0.06)",
			color: "var(--dsw-alias-label-primary)"
		};

		export const sheen = {
			position: "absolute",
			inset: 0,
			borderRadius: "inherit",
			pointerEvents: "none",
			background:
				"radial-gradient(130% 90% at 18% 0%, rgba(255,255,255,0.14), rgba(255,255,255,0.03) 40%, transparent 62%)"
		};

		export const glassButton = {
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
		export function RefreshIcon({ spinning }) {
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

		export function InfoIcon() {
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
		export function TokenBar({ input, cacheRead, output }) {
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
