// 今日消费余额差估算：验证“用完再充值”不会把当天已发生的消费抹掉。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepseek } from "../lib/providers/deepseek.js";

test("余额差估算：用光 → 充值 → 继续用，累计值不被充值归零", async () => {
  const dir = mkdtempSync(join(tmpdir(), "billing-glass-today-"));
  const ctx = {
    credentials: { resolve: async () => void 0 }, // 无平台 token，走估算
    get(name) { return name === "dshHomePath" ? (...parts) => join(dir, ...parts) : null; },
    logger: { warn() {} }
  };
  const call = async (total) => (await deepseek.todayConsumed(ctx, {}, { total })).consumed;

  assert.equal(await call(100), 0, "初始余额 100，消费 0");
  assert.equal(await call(0), 100, "用光余额，消费 100");
  assert.equal(await call(100), 100, "充值回 100，已发生消费仍保留");
  assert.equal(await call(80), 120, "充值后再用 20，累计 120");
  rmSync(dir, { recursive: true, force: true });
});
