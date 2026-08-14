// client bundle 结构验证：在 Node 里 stub 浏览器环境，
// 验证 __ModuleLoader__.load 注册、factory 可执行、插件导出 apply/inject。
import { test } from "node:test";
import assert from "node:assert/strict";

test("client bundle registers and factory executes", async () => {
  let captured = null;
  const reactStub = {
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value })
  };
  const jsxRuntimeStub = {
    jsx: (...args) => args,
    jsxs: (...args) => args,
    Fragment: Symbol("Fragment")
  };
  const requireStub = (name) => {
    if (name === "react") return reactStub;
    if (name === "react/jsx-runtime") return jsxRuntimeStub;
    throw new Error(`unexpected require: ${name}`);
  };
  globalThis.window = {
    __ModuleLoader__: {
      load: (spec) => { captured = spec; }
    }
  };

  await import("../lib/client.js");

  assert.ok(captured !== null, "__ModuleLoader__.load 被调用");
  assert.equal(captured.id, "dsh-billing-glass");
  assert.equal(typeof captured.factory, "function");

  const moduleExports = captured.factory(requireStub);
  assert.equal(typeof moduleExports.apply, "function");
  assert.deepEqual(moduleExports.inject, ["slots"]);

  // apply 应把悬浮卡注册进 shell.overlay、消息费用角标注册进 assistant-actions
  const calls = [];
  const ctx = {
    slots: {
      inject: (slot, fn) => {
        calls.push(["inject", slot]);
        fn(); // 立即执行注册函数，模拟框架挂载
        return () => {};
      },
      register: (descriptor, component) => {
        calls.push(["register", descriptor]);
        assert.equal(typeof component, "function");
      }
    }
  };
  moduleExports.apply(ctx);
  assert.deepEqual(calls[0], ["inject", "shell.overlay"]);
  assert.deepEqual(calls[1][0], "register");
  assert.equal(calls[1][1].name, "shell.overlay");
  assert.equal(calls[1][1].id, "billing-glass");
  assert.deepEqual(calls[2], ["inject", "conversation.chat.assistant-actions"]);
  assert.deepEqual(calls[3][0], "register");
  assert.equal(calls[3][1].name, "conversation.chat.assistant-actions");
  assert.equal(calls[3][1].id, "billing-glass-cost");
  delete globalThis.window;
});
