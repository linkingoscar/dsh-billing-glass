// 纯展示层格式工具：金额/token/时间/位置。
import { POS_KEY, COLLAPSED_KEY } from "./constants.js";
		export function currencySymbol(code) {
			switch (code) {
				case "CNY": return "¥";
				case "USD": return "$";
				case "EUR": return "€";
				case "JPY": return "¥";
				case "HKD": return "HK$";
				default: return code ? `${code} ` : "";
			}
		}

		export function formatMoney(value, currency) {
			const symbol = currencySymbol(currency);
			if (!Number.isFinite(value) || value <= 0) return `${symbol}0`;
			if (value >= 100) return `${symbol}${value.toFixed(0)}`;
			if (value >= 1) return `${symbol}${value.toFixed(2)}`;
			if (value >= 0.01) return `${symbol}${value.toFixed(3)}`;
			return `${symbol}${value.toPrecision(2)}`;
		}

		export function formatTokens(value) {
			return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}


		export function formatTime(date) {
			const hh = String(date.getHours()).padStart(2, "0");
			const mm = String(date.getMinutes()).padStart(2, "0");
			const ss = String(date.getSeconds()).padStart(2, "0");
			return `${hh}:${mm}:${ss}`;
		}

		export function clamp(value, min, max) {
			return Math.min(max, Math.max(min, value));
		}

		export function loadPos() {
			try {
				const parsed = JSON.parse(localStorage.getItem(POS_KEY) ?? "null");
				if (parsed && typeof parsed === "object" && Number.isFinite(parsed.right) && Number.isFinite(parsed.bottom)) {
					return { right: parsed.right, bottom: parsed.bottom };
				}
			} catch {}
			return { right: 16, bottom: 16 };
		}

		export function loadCollapsed() {
			try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
		}
