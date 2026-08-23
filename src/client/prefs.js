// 显示偏好：localStorage 持久化 + 订阅通知（设置卡片与胶囊/角标共用）。
/** @typedef {{capsule: boolean, costChip: boolean}} Prefs */
const PREFS_KEY = "dsh-billing-glass.prefs.v1";

/** @type {Prefs|null} */
let cache = null;
/** @type {Set<(prefs: Prefs) => void>} */
const listeners = new Set();

/** 读取当前偏好（带缓存；缺省即开启）。
 * @returns {Prefs}
 */
export function loadPrefs() {
	if (cache !== null) return cache;
	/** @type {Record<string, unknown>} */
	let stored = {};
	try {
		const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
		if (parsed !== null && typeof parsed === "object") stored = parsed;
	} catch {}
	cache = {
		capsule: stored.capsule !== false,
		costChip: stored.costChip !== false
	};
	return cache;
}

/** 写入一项偏好并广播（持久化失败不阻断内存态）。
 * @param {"capsule"|"costChip"} key
 * @param {unknown} value
 * @returns {void}
 */
export function setPref(key, value) {
	const next = { ...loadPrefs(), [key]: value === true };
	try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch {}
	cache = next;
	for (const notify of listeners) {
		try { notify(next); } catch {}
	}
}

/** 订阅偏好变化；返回取消订阅函数。
 * @param {(prefs: Prefs) => void} notify
 * @returns {() => void}
 */
export function subscribePrefs(notify) {
	listeners.add(notify);
	return () => { listeners.delete(notify); };
}
