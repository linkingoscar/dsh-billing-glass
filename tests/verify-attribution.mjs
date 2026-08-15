// canonical attribution pipeline 回归：live/replay 使用同一优先级，
// source/header 冲突、source 缺 model、模型全缺都 fail closed。
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMessageContext, priceEventInto, upsertMessageSample, emptyCostRecord } from "../lib/index.js";
import { deepseek } from "../lib/providers/deepseek.js";

test("source/header 冲突：header provider/model 优先", () => {
  const context = resolveMessageContext({
    type: "assistant/message",
    data: { message: { id: "m1", source: { provider: "xai", model: "grok-4.3" } }, usage: { inputTokens: 1 } }
  }, { provider: "deepseek-official", model: "deepseek-v4-flash" });
  assert.equal(context.provider.id, "deepseek");
  assert.equal(context.model, "deepseek-v4-flash");
});

test("source 缺 model / header 有 Flash：按 Flash 计价，不用 defaultModel", () => {
  const context = resolveMessageContext({
    type: "assistant/message",
    data: { message: { id: "m1", source: { provider: "deepseek-official" } }, usage: { inputTokens: 1_000_000 } }
  }, { provider: "deepseek-official", model: "deepseek-v4-flash" });
  assert.equal(context.model, "deepseek-v4-flash");
  const record = emptyCostRecord();
  const sample = priceEventInto(record, {
    type: "assistant/message",
    time: Date.parse("2026-08-20T20:00:00+08:00"),
    data: { message: { id: "m1", source: {} }, usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 } }
  }, deepseek, context);
  assert.equal(sample.priced, true);
  assert.ok(Math.abs(sample.costNative - 1.5) < 1e-9, "按 Flash 空闲价 1.5 计价，而非 Pro/默认价");
});

test("header/source 都没有 model：model_unknown 未计价，绝不 fallback 默认模型", () => {
  const context = resolveMessageContext({
    type: "assistant/message",
    data: { message: { id: "m1", source: { provider: "deepseek-official" } }, usage: { inputTokens: 1 } }
  }, { provider: "deepseek-official" });
  assert.equal(context.model, null);
  const record = emptyCostRecord();
  const sample = priceEventInto(record, {
    type: "assistant/message",
    time: Date.now(),
    data: { message: { id: "m1", source: {} }, usage: { inputTokens: 1, outputTokens: 1 } }
  }, deepseek, context);
  assert.equal(sample.priced, false);
  assert.equal(sample.unpricedReason, "model_unknown");
  upsertMessageSample(record, "m1", sample);
  assert.equal(record.unpricedCalls, 1);
});

test("同一 messageId 重复 upsert：整个 pipeline 幂等，不重复累计", () => {
  const context = { provider: deepseek, model: "deepseek-v4-flash" };
  const event = {
    type: "assistant/message",
    time: Date.parse("2026-08-20T20:00:00+08:00"),
    data: { message: { id: "dup" }, usage: { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 } }
  };
  const record = emptyCostRecord();
  const sample = priceEventInto(record, event, deepseek, context);
  upsertMessageSample(record, "dup", sample);
  upsertMessageSample(record, "dup", sample);
  assert.equal(record.calls, 1, "同一 messageId 只算一次");
  assert.equal(record.inputTokens, 1_000_000);
  assert.ok(Math.abs(record.costNative - sample.costNative) < 1e-9);
});
