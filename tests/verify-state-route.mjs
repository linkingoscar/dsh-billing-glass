// 聚合路由集成冒烟：用 mock ctx 直接驱动 apply()，
// 验证 /api/billing-glass/state 的 sessionId 传递、会话费用、
// DeepSeek 余额缓存 TTL 与 force 绕过（不访问真实网络）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temp = mkdtempSync(join(tmpdir(), "dsh-billing-glass-state-"));
process.env.DSH_HOME = temp;

let fetchCalls = 0;
let balanceTotal = 100;
globalThis.fetch = async (url) => {
  fetchCalls += 1;
  const body = JSON.stringify({
    is_available: true,
    balance_infos: [{ total_balance: balanceTotal, granted_balance: 10, topped_up_balance: 90, currency: "CNY" }]
  });
  return {
    ok: true,
    status: 200,
    text: async () => body,
    json: async () => JSON.parse(body)
  };
};

const { apply } = await import("../lib/index.js");

const routes = new Map();
let sessionHandler = null;
const ctx = {
  get(name) {
    if (name === "sessionPersistence") {
      return {
        readStoredRevision: async () => "r1",
        readRaw: async () => ({
          content: [
            JSON.stringify({ type: "request/header", time: Date.now(), data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-pro" } } } }),
            JSON.stringify({
              type: "assistant/message",
              time: Date.now(),
              data: {
                message: { id: "m1", source: { provider: "deepseek-official", model: "deepseek-v4-pro" } },
                usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 500_000 }
              }
            })
          ].join("\n")
        })
      };
    }
    if (name === "agentDefaultModel") {
      return { currentSelection: () => ({ provider: "deepseek-official", model: "deepseek-v4-pro" }) };
    }
    if (name === "dshHomePath") return (...parts) => join(temp, ...parts);
    return null;
  },
  credentials: {
    resolve: async (ref) => (ref === "DEEPSEEK_API_KEY" ? { value: "sk-test" } : void 0)
  },
  webServer: {
    register(descriptor) { routes.set(descriptor.path, descriptor.handler); }
  },
  on(event, handler) { if (event === "session/event") sessionHandler = handler; },
  effect(fn) { fn(); },
  logger: { warn() {}, error() {}, info() {} }
};

apply(ctx);
const stateHandler = routes.get("/api/billing-glass/state");
assert.ok(typeof stateHandler === "function", "state 路由已注册");

function request(url) {
  return new Promise((resolve) => {
    let body = "";
    const res = {
      writeHead(status) { res.status = status; },
      end(chunk) { body += chunk; res.status = res.status ?? 200; resolve({ status: res.status, body: JSON.parse(body) }); }
    };
    stateHandler({ url }, res).catch(() => {});
  });
}

test("state 路由：sessionId 驱动会话费用与活跃供应商，DeepSeek 余额可返回", async () => {
  sessionHandler({ id: "s1" }, {
    type: "request/header",
    time: Date.now(),
    data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-pro" } } }
  });
  sessionHandler({ id: "s1" }, {
    type: "assistant/message",
    time: Date.now(),
    data: {
      message: { id: "m2", source: { provider: "deepseek-official", model: "deepseek-v4-pro" } },
      usage: { inputTokens: 2_000_000, cacheReadTokens: 0, outputTokens: 1_000_000 }
    }
  });
  const { status, body } = await request("/api/billing-glass/state?sessionId=s1");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.sessionId, "s1");
  assert.equal(body.activeProvider, "deepseek");
  assert.equal(body.activeModel, "deepseek-v4-pro");
  const deepseek = body.providers.find((p) => p.id === "deepseek");
  assert.ok(deepseek, "DeepSeek provider 行存在");
  assert.equal(deepseek.balance.total, 100);
  assert.ok(deepseek.session !== null, "会话费用存在");
  assert.ok(deepseek.session.costUsd > 0, "会话费用 > 0");
  assert.equal(deepseek.keyConfigured, true);
});

test("state 路由：force=1&providerId 绕过 DeepSeek 余额缓存", async () => {
  const before = fetchCalls;
  await request("/api/billing-glass/state?sessionId=s1");
  assert.equal(fetchCalls, before, "缓存命中不重复请求余额接口");
  await request("/api/billing-glass/state?sessionId=s1&force=1&providerId=deepseek");
  assert.equal(fetchCalls, before + 1, "force 绕过缓存重新请求余额接口");
  balanceTotal = 88;
  const { body } = await request("/api/billing-glass/state?sessionId=s1&force=1&providerId=deepseek");
  assert.equal(body.providers.find((p) => p.id === "deepseek").balance.total, 88, "刷新后拿到新余额");
});

test("state 路由：未知模型 fail closed，计入 unpricedCalls 而不是 0 元", async () => {
  sessionHandler({ id: "s1" }, {
    type: "request/header",
    time: Date.now(),
    data: { header: { config: { provider: "xai", model: "brand-new-model" } } }
  });
  sessionHandler({ id: "s1" }, {
    type: "assistant/message",
    time: Date.now(),
    data: {
      message: { id: "m3", source: { provider: "xai", model: "brand-new-model" } },
      usage: { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 100 }
    }
  });
  const { body } = await request("/api/billing-glass/state?sessionId=s1&force=1&providerId=deepseek");
  const xai = body.providers.find((p) => p.id === "xai");
  assert.ok(xai, "xai provider 行存在");
  assert.equal(xai.session.unpricedCalls, 1);
  assert.equal(xai.session.costNative, 0);
  assert.equal(xai.session.costUsd, 0);
});

test("state 路由：未传 sessionId 时回退后台配置供应商", async () => {
  const { body } = await request("/api/billing-glass/state");
  assert.equal(body.activeProvider, null);
  assert.equal(body.configuredProvider, "deepseek");
});

test("清理临时目录", () => {
  rmSync(temp, { recursive: true, force: true });
});
