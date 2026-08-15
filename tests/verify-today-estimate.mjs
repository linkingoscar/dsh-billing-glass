// 今日消费展示口径：未配置 DEEPSEEK_PLATFORM_TOKEN 时不显示估算行，
// 避免充值/退款造成统计混淆。
import { test } from "node:test";
import assert from "node:assert/strict";
import { deepseek } from "../lib/providers/deepseek.js";

test("未配置 DEEPSEEK_PLATFORM_TOKEN：todayConsumed 返回 null（不显示今日消费）", async () => {
  const ctx = {
    credentials: { resolve: async () => void 0 },
    logger: { warn() {} }
  };
  assert.equal(await deepseek.todayConsumed(ctx, {}, { total: 100 }), null);
  assert.equal(await deepseek.todayConsumed(ctx, {}, { total: 0 }), null);
});
