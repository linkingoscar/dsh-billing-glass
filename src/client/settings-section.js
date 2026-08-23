// 设置卡片（Harness settings.section 槽位，v0.1.0-rc.7+ 可用；更早宿主上
// slots.inject 静默等待声明，不会报错——优雅降级为无此设置页）。
import { useState, useEffect, jsx, jsxs } from "./runtime.js";
import { loadPrefs, setPref, subscribePrefs } from "./prefs.js";
import { POS_KEY } from "./constants.js";

const rowStyle = {
	display: "flex", alignItems: "center", justifyContent: "space-between",
	gap: 12, padding: "9px 0"
};

const labelStyle = {
	fontSize: 13, lineHeight: "18px", color: "var(--dsw-alias-label-primary)"
};

const hintStyle = {
	marginTop: 8, paddingTop: 8,
	borderTop: "1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 16%, transparent)",
	fontSize: 11, lineHeight: "16px",
	color: "var(--dsw-alias-label-secondary)"
};

/** iOS 风格开关。
 * @param {{checked: boolean, onChange: () => void, label: string}} _
 */
function Switch({ checked, onChange, label }) {
	const track = {
		flex: "none", position: "relative", width: 40, height: 24,
		borderRadius: 999, border: 0, padding: 0, cursor: "pointer",
		background: checked
			? "#5B9DFF"
			: "color-mix(in srgb, var(--dsw-alias-label-secondary) 30%, transparent)",
		transition: "background .18s ease"
	};
	const knob = {
		position: "absolute", top: 2, left: checked ? 18 : 2,
		width: 20, height: 20, borderRadius: "50%",
		background: "#ffffff",
		boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
		transition: "left .18s ease"
	};
	return jsx("button", {
		type: "button",
		role: "switch",
		"aria-checked": checked === true,
		"aria-label": label,
		onClick: onChange,
		style: track,
		children: jsx("span", { "aria-hidden": true, style: knob })
	});
}

export function BillingGlassSettingsSection() {
	const [prefs, setPrefs] = useState(loadPrefs);
	useEffect(() => subscribePrefs(setPrefs), []);
	/**
	 * @param {"capsule"|"costChip"} key
	 * @returns {() => void}
	 */
	const toggle = (key) => () => { setPref(key, !prefs[key]); };
	const resetPosition = () => {
		try { localStorage.removeItem(POS_KEY); } catch {}
	};

	return jsxs("div", {
		"data-plugin": "dsh-billing-glass",
		style: { maxWidth: 420 },
		children: [
			jsxs("div", {
				style: rowStyle,
				children: [
					jsx("span", { style: labelStyle, children: "显示悬浮胶囊 / 账单卡" }),
					jsx(Switch, { checked: prefs.capsule === true, onChange: toggle("capsule"), label: "显示悬浮胶囊或账单卡" })
				]
			}),
			jsxs("div", {
				style: rowStyle,
				children: [
					jsx("span", { style: labelStyle, children: "显示每条消息费用角标" }),
					jsx(Switch, { checked: prefs.costChip === true, onChange: toggle("costChip"), label: "显示每条消息费用角标" })
				]
			}),
			jsxs("div", {
				style: { ...rowStyle, justifyContent: "flex-start" },
				children: [
					jsx("button", {
						type: "button",
						onClick: resetPosition,
						style: {
							border: "1px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 28%, transparent)",
							borderRadius: 7, padding: "3px 10px", cursor: "pointer",
							background: "transparent",
							color: "var(--dsw-alias-label-primary)",
							fontSize: 12, lineHeight: "18px"
						},
						children: "恢复默认位置"
					}),
					jsx("span", { style: { ...hintStyle, marginTop: 0, paddingTop: 0, borderTop: 0 }, children: "悬浮卡拖动位置会保存在本机" })
				]
			}),
			jsx("div", { style: hintStyle, children: "更改即时生效并仅保存在本机浏览器；隐藏胶囊后可回到这里重新打开。" })
		]
	});
}
