// 消费账本验证：幂等记录、会话查询、今日/本月/累计聚合。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
    nativeCurrency: "CNY",
    time: Date.parse("2026-08-14T10:00:00+08:00"),
    costNative: 1.5,
    costUsd: 0.21,
    priced: true,
    inputTokens: 1000,
    cacheReadTokens: 2000,
    outputTokens: 500,
    ...over
  };
}

test("record 幂等：同 sessionId+messageId 覆盖不重复", () => {
  const { ledger } = makeLedger();
  ledger.record(entry());
  ledger.record(entry({ costNative: 2.5, costUsd: 0.35 }));
  const messages = ledger.querySession("s1");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].costNative, 2.5);
});

test("querySession 按时间升序，queryMessage 单条查询", () => {
  const { ledger } = makeLedger();
  ledger.record(entry({ messageId: "m2", time: Date.parse("2026-08-14T12:00:00+08:00") }));
  ledger.record(entry({ messageId: "m1", time: Date.parse("2026-08-14T10:00:00+08:00") }));
  const messages = ledger.querySession("s1");
  assert.deepEqual(messages.map((m) => m.messageId), ["m1", "m2"]);
  assert.equal(ledger.queryMessage("s1", "m2").costNative, 1.5);
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

test("持久化：append-only JSONL 落盘，重新加载可恢复", () => {
  const { dir, ledger } = makeLedger();
  ledger.record(entry());
  ledger.flushSync();
  const file = join(dir, "billing-glass-ledger.jsonl");
  assert.ok(existsSync(file));
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "每次 flush 只追加新行，不整文件重写");
  const reloaded = createLedger({}, { storagesDir: dir });
  assert.equal(reloaded.queryMessage("s1", "m1").costNative, 1.5);
  assert.equal(reloaded.queryMessage("s1", "m1").nativeCurrency, "CNY");
  rmSync(dir, { recursive: true, force: true });
});

test("旧版 billing-glass-ledger.json 自动迁移为原生币种语义", () => {
  const dir = mkdtempSync(join(tmpdir(), "billing-glass-ledger-legacy-"));
  const legacy = {
    version: 1,
    records: [{
      sessionId: "s1", messageId: "m1", providerId: "deepseek", model: "deepseek-v4-pro",
      currency: "CNY", time: Date.now(), cost: 1.5, costUsd: 0.21,
      inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 500
    }]
  };
  writeFileSync(join(dir, "billing-glass-ledger.json"), JSON.stringify(legacy), "utf8");
  const ledger = createLedger({}, { storagesDir: dir });
  const migrated = ledger.queryMessage("s1", "m1");
  assert.equal(migrated.costNative, 1.5);
  assert.equal(migrated.nativeCurrency, "CNY");
  assert.equal(migrated.priced, true);
  rmSync(dir, { recursive: true, force: true });
});

test("损坏 JSONL：坏行计数、尾部残行恢复并重写修复", () => {
  const dir = mkdtempSync(join(tmpdir(), "billing-glass-ledger-corrupt-"));
  const file = join(dir, "billing-glass-ledger.jsonl");
  const lines = [
    JSON.stringify(entry({ messageId: "ok1" })),
    "{ this is not valid json",
    JSON.stringify(entry({ messageId: "ok2" }))
  ];
  writeFileSync(file, lines.join("\n") + "\n" + '{"sessionId":"s1","messageId":"tail-partial"', "utf8");

  const ledger = createLedger({}, { storagesDir: dir });
  const health = ledger.health();
  assert.equal(health.invalidLines, 1);
  assert.equal(health.recoveredTail, 1);
  assert.equal(health.degraded, true);
  assert.equal(ledger.querySession("s1").length, 2, "坏行被跳过，合法记录保留");

  const repaired = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(repaired.length, 2, "启动后立即 compact 修复文件，只保留合法记录");
  rmSync(dir, { recursive: true, force: true });
});

test("summary 支持 IANA timezone：同一 epoch 在不同时区归入不同“今日”", () => {
  const { ledger } = makeLedger();
  ledger.record(entry({ time: Date.parse("2026-08-15T05:30:00Z") }));
  const now = new Date("2026-08-15T00:30:00Z");
  assert.equal(ledger.summary(now, "Asia/Shanghai").today.calls, 1, "上海已是 8/15，计入今日");
  assert.equal(ledger.summary(now, "America/New_York").today.calls, 0, "纽约还是 8/14，不计入今日");
  assert.equal(ledger.summary(now, "America/New_York").total.calls, 1);
});

test("summary 暴露未计价条数（fail closed 记录）", () => {
  const { ledger } = makeLedger();
  ledger.record(entry());
  ledger.record(entry({ messageId: "unpriced", priced: false, unpricedReason: "pricing_unknown", costNative: 0, costUsd: 0 }));
  const s = ledger.summary(new Date("2026-08-14T20:00:00+08:00"));
  assert.equal(s.today.calls, 2);
  assert.equal(s.today.unpricedCalls, 1);
  assert.ok(Math.abs(s.today.costUsd - 0.21) < 1e-9, "未计价消息不得计入金额");
});
