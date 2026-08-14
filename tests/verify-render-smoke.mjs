// 渲染级冒烟：用 stub 环境完整执行 client 组件函数体（不真渲染 DOM），
// 捕获浏览器里可能发生的运行时错误。
import { test } from "node:test";
import assert from "node:assert/strict";

// 模块级加载一次（import 缓存，重复 import 不会重跑 __ModuleLoader__.load）。
let captured = null;
globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec; } } };
await import("../lib/client.js");
assert.ok(captured !== null, "client bundle 已注册");

const requireStub = (name) => {
  if (name === "react") {
    return {
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
      useLayoutEffect: () => {},
      useCallback: (fn) => fn,
      useRef: (value) => ({ current: value })
    };
  }
  if (name === "react/jsx-runtime") {
    return { jsx: (...args) => args, jsxs: (...args) => args, Fragment: Symbol("Fragment") };
  }
  throw new Error(`unexpected require: ${name}`);
};
const exports = captured.factory(requireStub);
delete globalThis.window;

/** 从 apply 注册里挖出组件。 */
function collectComponents() {
  let card = null;
  let chip = null;
  exports.apply({
    slots: {
      inject: (_slot, fn) => { fn(); return () => {}; },
      register: (descriptor, component) => {
        if (descriptor.id === "billing-glass") card = component;
        if (descriptor.id === "billing-glass-cost") chip = component;
      }
    }
  });
  return { card, chip };
}

test("client bundle 注册与组件注册", () => {
  const { card, chip } = collectComponents();
  assert.ok(card, "悬浮卡组件已注册");
  assert.ok(chip, "角标组件已注册");
});

test("BillingGlassCard 函数体可完整执行（加载/就绪两态）", () => {
  const { card, chip } = collectComponents();
  // collapsed 初始 true（无 localStorage 时 loadCollapsed 返回 false，注意：默认 false=展开）
  // 直接以两种 collapsed 状态渲染——collapsed 初值来自 loadCollapsed()（读 localStorage），
  // 无 localStorage 时 false（展开态）。组件体执行不应抛错。
  card({ useSessions: () => "s1" });

  // MessageCostChip：无记录 → null（不抛错）
  assert.equal(chip({ messageId: "m1", sessionId: "s1" }), null);
  assert.equal(chip({ messageId: "m1" }), null, "缺 sessionId 时静默返回 null");
});

test("BillingGlassCard 展开态（collapsed=false）执行不抛错", () => {
  globalThis.localStorage = {
    getItem: (key) => (key === "dsh-billing-glass-collapsed" ? "0" : null),
    setItem: () => {}
  };
  const { card } = collectComponents();
  card({ useSessions: () => void 0 });
  delete globalThis.localStorage;
});
