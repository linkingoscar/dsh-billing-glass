/** Optional real-backend integration: node scripts/check-installed-harness.mjs <runtime directory>. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { apply } from "../lib/index.js";

if (!process.argv[2]) throw new Error("Pass the directory containing the official Harness node_modules");
const runtime = createRequire(join(resolve(process.argv[2]), "package.json"));
const load = (/** @type {string} */ name) => import(pathToFileURL(runtime.resolve(name)).href);
const { Context } = await load("@deepseek-ai/cordis");
const { default: Persistence } = await load("@deepseek-ai/dsh-session-persistence-jsonl");
const { SESSION_FORMAT_VERSION, SessionId } = await load("@deepseek-ai/dsh-session");
const version = runtime("@deepseek-ai/dsh/package.json").version;
const dir = await mkdtemp(join(tmpdir(), "billing-real-harness-"));
const host = new Context();
/** @type {Array<() => void>} */
const disposers = [];
try {
  await host.plugin(Persistence, { root: join(dir, "sessions"), compression: "none" });
  const persistence = host.sessionPersistence;
  const id = SessionId("billing-real-backend");
  const time = Date.parse("2026-10-01T02:00:00Z");
  const writer = await persistence.create({ id, createdAt: time, version: SESSION_FORMAT_VERSION, delegationDepth: 0, isSeeded: false });
  try {
    await writer.append([
      { type: "turn/start", seq: 0, time, data: { turn: 1 } },
      { type: "step/start", seq: 1, time, data: { turn: 1, step: 1 } },
      { type: "request/header", seq: 2, time, data: { turn: 1, step: 1, header: { config: { provider: "deepseek-official", model: "deepseek-flash" } } } },
      { type: "assistant/message", seq: 3, time: time + 1, surfaceOp: "append", data: {
        turn: 1, step: 1, stream: [],
        message: { id: "message-one", role: "assistant", content: [{ type: "text", text: "Synthetic compatibility fixture" }], source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } },
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }
      } },
      { type: "step/end", seq: 4, time: time + 2, data: { turn: 1, step: 1 } },
      { type: "turn/end", seq: 5, time: time + 3, data: { turn: 1, reason: { kind: "completed" } } }
    ]);
  } finally { await writer.close(); }
  const routes = new Map();
  apply({
    get(name) {
      if (name === "sessionPersistence") return persistence;
      if (name === "dshHomePath") return (/** @type {string[]} */ ...parts) => join(dir, ...parts);
    },
    credentials: { resolve: async () => undefined },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === "function") disposers.push(cleanup); return () => {}; },
    on() { return () => {}; }, logger: { warn(...args) { console.error(...args); } }
  });
  async function query() {
    /** @type {{messages: Array<{messageId: string, costUsd: number, pricingSnapshot: {mode: string, usd: {input: number}}}>}|undefined} */
    let body;
    await routes.get("/api/billing-glass/ledger")({ url: `/api/billing-glass/ledger?sessionId=${id}`, method: "GET" }, {
      writeHead(/** @type {number} */ code) { assert.equal(code, 200); }, end(/** @type {string} */ value) { body = JSON.parse(value); }
    });
    assert.ok(body);
    return body;
  }
  const first = await query();
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0].messageId, "message-one");
  assert.equal(first.messages[0].costUsd, 0.15, "real persisted holiday request uses off-peak price");
  assert.equal(first.messages[0].pricingSnapshot.mode, "offPeak");
  assert.equal(first.messages[0].pricingSnapshot.usd.input, 0.15);
  const second = await query();
  assert.deepEqual(second.messages, first.messages, "repeat replay is idempotent");
  // A fresh write handle proves the plugin closed the real read handle and left the backend usable.
  const reopened = await persistence.open(id, "write");
  await reopened.close();
  console.log(`PASS official Harness ${version}: real JSONL create/append/close → billing cold replay, repeat dedupe and holiday costing`);
} finally {
  for (const dispose of disposers.reverse()) dispose();
  await host.fiber.dispose();
  await rm(dir, { recursive: true, force: true });
}
