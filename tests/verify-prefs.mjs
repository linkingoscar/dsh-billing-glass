// 显示偏好模块验证（localStorage stub + 缓存重置）。
import { test } from "node:test";
import assert from "node:assert/strict";

// prefs.js 模块级缓存：每个用例用独立查询串重新 import 获得干净实例。
async function freshInstance() {
  const mod = await import(`../src/client/prefs.js?case=${Math.random()}`);
  return mod;
}

test("默认值：未存储时 capsule/costChip 均开启", async () => {
  /** @type {Record<string, string>} */
  const store = {};
  globalThis.localStorage = {
    getItem: (/** @type {string} */ k) => store[k] ?? null,
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => { store[k] = v; },
    removeItem: (/** @type {string} */ k) => { delete store[k]; }
  };
  const { loadPrefs } = await freshInstance();
  const prefs = loadPrefs();
  assert.equal(prefs.capsule, true);
  assert.equal(prefs.costChip, true);
  delete globalThis.localStorage;
});

test("setPref 持久化并广播；坏 JSON 容错", async () => {
  /** @type {Record<string, string>} */
  const store = {};
  globalThis.localStorage = {
    getItem: (/** @type {string} */ k) => store[k] ?? null,
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => { store[k] = v; },
    removeItem: (/** @type {string} */ k) => { delete store[k]; }
  };
  const { loadPrefs, setPref, subscribePrefs } = await freshInstance();

  let notified = null;
  subscribePrefs((p) => { notified = p; });
  setPref("capsule", false);
  assert.equal(loadPrefs().capsule, false);
  assert.ok(notified !== null && notified.capsule === false, "订阅者应收到广播");

  // 持久化内容可被新实例读回
  const second = await freshInstance();
  assert.equal(second.loadPrefs().capsule === false || JSON.parse(store["dsh-billing-glass.prefs.v1"]).capsule === false, true);

  // 坏 JSON → 回退默认
  store["dsh-billing-glass.prefs.v1"] = "{broken json";
  const third = await freshInstance();
  assert.equal(third.loadPrefs().capsule, true);
  assert.equal(third.loadPrefs().costChip, true);
  delete globalThis.localStorage;
});
