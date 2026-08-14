// 消费账本验证：幂等记录、会话查询、今日/本月/累计聚合。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLedger } from "../lib/ledger.js";

function makeLedger() {
  const dir = mkdtempSync(join(tmpdir(), "billing-glass-ledger-"));
  return { dir, ledger: createLedger({}, { storagesDir: dir }) };
}

function entry(over = {}) {
  return {
    sessionId: "s1",
    messageId: "m1",
    providerId: "deepseek",
    model: "deepseek-v4-pro",
    currency: "CNY",
    time: Date.parse("2026-08-14T10:00:00+08:00"),
    cost: 1.5,
    costUsd: 0.21,
    inputTokens: 1000,
    cacheReadTokens: 2000,
    outputTokens: 500,
    ...over
  };
}

test("record 幂等：同 sessionId+messageId 覆盖不重复", () => {
  const { ledger } = makeLedger();
  ledger.record(entry());
  ledger.record(entry({ cost: 2.5, costUsd: 0.35 }));
  const messages = ledger.querySession("s1");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].cost, 2.5);
});

test("querySession 按时间升序，queryMessage 单条查询", () => {
  const { ledger } = makeLedger();
  ledger.record(entry({ messageId: "m2", time: Date.parse("2026-08-14T12:00:00+08:00") }));
  ledger.record(entry({ messageId: "m1", time: Date.parse("2026-08-14T10:00:00+08:00") }));
  const messages = ledger.querySession("s1");
  assert.deepEqual(messages.map((m) => m.messageId), ["m1", "m2"]);
  assert.equal(ledger.queryMessage("s1", "m2").cost, 1.5);
  assert.equal(ledger.queryMessage("s1", "nope"), null);
});

test("summary 今日/本月/累计聚合（USD）", () => {
  const { ledger } = makeLedger();
  const now = new Date("2026-08-14T20:00:00+08:00");
  // 今天两条
  ledger.record(entry({ messageId: "a", costUsd: 0.1, time: Date.parse("2026-08-14T09:00:00+08:00") }));
  ledger.record(entry({ messageId: "b", costUsd: 0.2, time: Date.parse("2026-08-14T15:00:00+08:00") }));
  // 本月早些时候一条
  ledger.record(entry({ messageId: "c", costUsd: 0.4, time: Date.parse("2026-08-03T10:00:00+08:00") }));
  // 上月一条
  ledger.record(entry({ messageId: "d", costUsd: 1.6, time: Date.parse("2026-07-20T10:00:00+08:00") }));

  const s = ledger.summary(now);
  const close = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(close(s.today.costUsd, 0.3));
  assert.equal(s.today.calls, 2);
  assert.ok(close(s.month.costUsd, 0.7));
  assert.equal(s.month.calls, 3);
  assert.ok(close(s.total.costUsd, 2.3));
  assert.equal(s.total.calls, 4);
  assert.equal(s.total.inputTokens, 4000);
});

test("持久化：flushSync 落盘，重新加载可恢复", () => {
  const { dir, ledger } = makeLedger();
  ledger.record(entry());
  ledger.flushSync();
  const file = join(dir, "billing-glass-ledger.json");
  assert.ok(existsSync(file));
  const reloaded = createLedger({}, { storagesDir: dir });
  assert.equal(reloaded.queryMessage("s1", "m1").cost, 1.5);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.records.length, 1);
  rmSync(dir, { recursive: true, force: true });
});
