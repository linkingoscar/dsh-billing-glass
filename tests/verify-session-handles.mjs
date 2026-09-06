import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../lib/index.js";

const TIME = Date.parse("2026-09-06T03:00:00Z");
const header = {
  type: "request/header", time: TIME,
  data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-pro" } } }
};
function message(id, inputTokens = 1_000_000) {
  return {
    type: "assistant/message", time: TIME,
    data: {
      turn: 1, step: 1, stream: [], message: { id },
      usage: { inputTokens, outputTokens: 100_000, cacheReadTokens: 50_000 }
    }
  };
}

function harness(t) {
  const home = mkdtempSync(join(tmpdir(), "billing-session-handles-"));
  const disposers = [];
  const routes = new Map();
  let listener;
  const model = {
    revision: "r1", events: [header, message("m1")], missing: false,
    failure: null, opened: 0, closed: 0, reads: 0
  };
  const persistence = {
    // A backend may expose this legacy flag during migration. Handles take precedence.
    supportsRawArtifacts: false,
    async stat(id) {
      assert.equal(id, "s1");
      if (model.failure === "stat") throw new Error("stat failed");
      return model.missing ? undefined : { revision: model.revision };
    },
    async open(id, access) {
      assert.equal(id, "s1");
      assert.equal(access, "read", "billing must never claim write ownership");
      if (model.failure === "open") throw new Error("open failed");
      model.opened++;
      return {
        async read() {
          model.reads++;
          if (model.failure === "read") throw new Error("read failed");
          return model.events;
        },
        async close() {
          model.closed++;
          if (model.failure === "close") throw new Error("close failed");
        }
      };
    }
  };
  const ctx = {
    get(name) {
      if (name === "sessionPersistence") return ctx.persistence;
      if (name === "dshHomePath") return (...parts) => join(home, ...parts);
      return undefined;
    },
    persistence,
    credentials: { resolve: async () => undefined },
    connection: { requestRejection: () => undefined },
    webServer: { register(route) { routes.set(route.path, route.handler); } },
    effect(fn) { const dispose = fn(); if (typeof dispose === "function") disposers.push(dispose); },
    on(name, handler) { if (name === "session/event") listener = handler; },
    logger: { warn() {} }
  };
  apply(ctx);
  t.after(() => {
    for (const dispose of disposers.reverse()) dispose();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    model, ctx,
    emit(event) { listener({ id: "s1" }, event); },
    async state(full = false) {
      let body;
      await routes.get("/api/billing-glass/state")({ url: "/api/billing-glass/state?sessionId=s1", method: "GET" }, {
        writeHead(status) { assert.equal(status, 200); },
        end(value) { body = JSON.parse(value); }
      });
      assert.equal(body.ok, true);
      return full ? body : body.providers.find(row => row.id === "deepseek").session;
    }
  };
}

test("SessionHandle: cold replay, live dedupe, revision cache and frozen historical prices", async (t) => {
  let now = TIME;
  t.mock.method(Date, "now", () => now);
  const h = harness(t);
  const cold = await h.state();
  assert.equal(cold?.calls, 1);
  assert.ok(cold.costUsd > 0);
  assert.equal(cold.inputTokens, 1_000_000);
  assert.equal(h.model.opened, 1);
  assert.equal(h.model.closed, 1);
  await h.state();
  assert.equal(h.model.reads, 1, "unchanged revision avoids another full read");

  h.emit(header);
  h.emit(message("m1"));
  h.emit(message("m2", 2_000_000));
  const live = await h.state();
  assert.equal(live.calls, 2, "replay/live duplicate is charged once");
  assert.equal(live.inputTokens, 3_000_000);

  h.model.revision = "r2";
  // The first stored pricing snapshot must survive a replay with changed source usage.
  h.model.events = [header, message("m1", 9_000_000), message("m2", 2_000_000), message("m3")];
  assert.equal((await h.state()).calls, 2, "changed revisions retain replay throttle");
  now += 2001;
  const refreshed = await h.state();
  assert.equal(refreshed.calls, 3);
  assert.equal(refreshed.inputTokens, 4_000_000, "historical snapshot is reused");
  assert.equal(h.model.reads, 2);
  assert.equal(h.model.closed, 2);
});

test("SessionHandle: cold replay restores model selection and live requests take precedence", async (t) => {
  const h = harness(t);
  const cold = await h.state(true);
  assert.equal(cold.activeProvider, "deepseek");
  assert.equal(cold.activeModel, "deepseek-v4-pro");
  assert.equal(cold.unrecognized, null);
  h.emit({ ...header, data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-flash" } } } });
  assert.equal((await h.state(true)).activeModel, "deepseek-v4-flash", "cached historical selection must not override a new request");
});

test("SessionHandle: unknown historical provider remains explicitly unrecognized", async (t) => {
  const h = harness(t);
  h.model.events = [{ ...header, data: { header: { config: { provider: "acceptance-unknown", model: "unknown-model" } } } }];
  const state = await h.state(true);
  assert.equal(state.activeProvider, null);
  assert.deepEqual(state.unrecognized, { provider: "acceptance-unknown", baseUrl: null, model: "unknown-model" });
});

test("SessionHandle: missing session does not open a handle", async (t) => {
  const h = harness(t);
  h.model.missing = true;
  assert.equal(await h.state(), null);
  assert.equal(h.model.opened, 0);
  h.model.missing = false;
  assert.equal((await h.state())?.calls, 1);
});

test("SessionHandle: failures preserve live costing, close acquired handles, and permit retry", async (t) => {
  for (const failure of ["stat", "open", "read", "close"]) {
    await t.test(failure, async (t) => {
      const h = harness(t);
      h.emit(header);
      h.emit(message("live"));
      h.model.failure = failure;
      assert.equal((await h.state()).calls, 1);
      assert.equal(h.model.closed, h.model.opened, "every acquired handle is closed even after read failure");
      h.model.failure = null;
      assert.equal((await h.state()).calls, 2, "failed replay must not poison the revision cache");
      assert.equal(h.model.closed, h.model.opened);
    });
  }
});

test("SessionHandle: revisions from different service instances are not comparable", async (t) => {
  const h = harness(t);
  assert.equal((await h.state())?.calls, 1);
  h.model.events = [header, message("m1"), message("m2")];
  h.ctx.persistence = { ...h.ctx.persistence };
  assert.equal((await h.state()).calls, 2, "same revision on a replacement service must be reread");
});
