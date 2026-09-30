import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { mainSessionId } from "../src/client/session-selection.js";
import { watchMessageSession, readMessageCost } from "../src/client/message-store.js";

test("main and sidebar ownership selects only the main session, including the blank view", () => {
  assert.equal(mainSessionId({ current: "legacy" }), "legacy");
  const byId = {
    side: { id: "side", retainedBy: { sidebar: 1 } },
    main: { id: "main", retainedBy: { mainView: 1 } }
  };
  assert.equal(mainSessionId({ byId }), "main");
  delete byId.main;
  assert.equal(mainSessionId({ byId }), undefined);
});

test("published card sends the retained main session to the state route", async () => {
  const effects = [], requests = [];
  let client, card;
  const sandbox = {
    URLSearchParams, AbortController, Intl,
    setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: () => null },
    document: { getElementById: () => ({}), addEventListener() {}, removeEventListener() {} },
    fetch: async url => { requests.push(url); return { ok: false, status: 503, json: async () => ({}) }; },
    window: { addEventListener() {}, removeEventListener() {}, __ModuleLoader__: { load(spec) {
      client = spec.factory(name => name === "react" ? {
        useState: value => [typeof value === "function" ? value() : value, () => {}],
        useEffect: effect => effects.push(effect), useLayoutEffect() {},
        useCallback: fn => fn, useRef: current => ({ current })
      } : { jsx: (...args) => args, jsxs: (...args) => args });
    } } }
  };
  vm.runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), sandbox);
  client.apply({ slots: {
    inject: (_name, register) => register(),
    register: (descriptor, component) => { if (descriptor.name === "shell.overlay") card = component; }
  } });
  card({ useSessions: select => select({ byId: { s1: { id: "s1", retainedBy: { mainView: 1 } } } }) });
  const disposers = effects.map(effect => effect());
  await Promise.resolve();
  for (const dispose of disposers) if (typeof dispose === "function") dispose();
  assert.equal(new URL(requests[0], "http://local").searchParams.get("sessionId"), "s1");
});

test("message chips share polls per session and release only their own pending request", async t => {
  const pending = [], intervals = new Set();
  t.mock.method(globalThis, "setInterval", fn => { intervals.add(fn); return fn; });
  t.mock.method(globalThis, "clearInterval", fn => intervals.delete(fn));
  t.mock.method(globalThis, "fetch", (url, { signal }) => new Promise(resolve => pending.push({ url, signal, resolve })));
  const stopA1 = watchMessageSession("A"), stopA2 = watchMessageSession("A"), stopB = watchMessageSession("B");
  t.after(() => { stopA1(); stopA2(); stopB(); });
  assert.equal(pending.length, 2, "many chips share one fetch per session");
  assert.equal(intervals.size, 2);
  assert.ok(pending.every(request => !request.signal.aborted), "sidebar does not abort main");
  pending[0].resolve({ ok: true, json: async () => ({ ok: true, messages: [{ messageId: "a", costNative: 1 }] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readMessageCost("A", "a").costNative, 1);
  stopA1();
  assert.equal(intervals.size, 2, "one remaining chip keeps its poll");
  stopB();
  assert.equal(pending[1].signal.aborted, true);
  pending[1].resolve({ ok: true, json: async () => ({ ok: true, messages: [{ messageId: "stale" }] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readMessageCost("B", "stale"), undefined, "disabled chips reject late responses");
  const stopNewB = watchMessageSession("B");
  t.after(stopNewB);
  assert.equal(pending.length, 3, "re-enable starts a fresh request");
  stopA2(); stopNewB(); stopNewB();
  assert.equal(intervals.size, 0);
  assert.equal(pending[2].signal.aborted, true);
});

test("published message chip labels estimates and exposes keyboard/screen-reader pricing provenance", async () => {
  const effects = [];
  let client, chip;
  const sandbox = {
    URLSearchParams, AbortController, Intl,
    setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: () => null },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, messages: [{
      messageId: "priced", costNative: .15, nativeCurrency: "USD", priced: true,
      pricingSnapshot: { source: "frozen-v1", mode: "offPeak", usd: { input: .15, cacheRead: .003, output: .6 } }
    }] }) }),
    window: { __ModuleLoader__: { load(spec) {
      client = spec.factory(name => name === "react" ? {
        useState: value => [typeof value === "function" ? value() : value, () => {}],
        useEffect: effect => effects.push(effect), useLayoutEffect() {},
        useCallback: fn => fn, useRef: current => ({ current })
      } : { jsx: (...args) => args, jsxs: (...args) => args });
    } } }
  };
  vm.runInNewContext(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"), sandbox);
  client.apply({ slots: {
    inject: (_name, register) => register(),
    register: (descriptor, component) => { if (descriptor.id === "billing-glass-cost") chip = component; }
  } });
  assert.equal(chip({ sessionId: "s1", messageId: "priced" }), null);
  const disposers = effects.splice(0).map(effect => effect());
  try {
    await new Promise(resolve => setImmediate(resolve));
    const [tag, props] = chip({ sessionId: "s1", messageId: "priced" });
    assert.equal(tag, "span");
    assert.match(props.children, /^≈/);
    assert.equal(props.tabIndex, 0);
    assert.equal(props["aria-label"], props.title);
    assert.match(props.title, /frozen-v1/);
    assert.match(props.title, /非官方账单/);
  } finally { for (const dispose of disposers) if (typeof dispose === "function") dispose(); }
});
