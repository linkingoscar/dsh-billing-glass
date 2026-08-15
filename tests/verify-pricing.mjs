// 定价引擎纯函数验证：政策链、峰谷时段、计价。
import { test } from "node:test";
import assert from "node:assert/strict";
import { priceAt, costOf, isPeak, activePolicy } from "../lib/providers/deepseek-pricing.js";

/** 北京时间指定时刻的 epoch ms。 */
function beijing(y, m, d, hh = 12, mm = 0) {
  // 手工构造 +08:00 时间戳
  return Date.UTC(y, m - 1, d, hh - 8, mm);
}

test("activePolicy 遵守有效期，空窗期返回 null", () => {
  assert.equal(activePolicy(beijing(2026, 1, 1)), null, "2026-01 无已审计政策覆盖");
  assert.equal(activePolicy(beijing(2026, 6, 1)).label, "V4 系列 75% 降价转永久（deepseek-v4-flash / deepseek-v4-pro 上线）");
  assert.equal(activePolicy(beijing(2026, 9, 1)).label, "峰谷定价：高峰 09:00-12:00 / 14:00-18:00（北京时间），空闲时段半价");
});

test("isPeak 北京时间峰谷判定", () => {
  assert.equal(isPeak(beijing(2026, 8, 20, 10)), true, "10:00 高峰");
  assert.equal(isPeak(beijing(2026, 8, 20, 15)), true, "15:00 高峰");
  assert.equal(isPeak(beijing(2026, 8, 20, 13)), false, "13:00 午间空闲");
  assert.equal(isPeak(beijing(2026, 8, 20, 20)), false, "20:00 空闲");
});

test("priceAt：V4 flash 峰谷价格（2026-08-17 之后）", () => {
  const peak = priceAt("deepseek-v4-flash", beijing(2026, 8, 20, 10));
  assert.equal(peak.mode, "peak");
  assert.equal(peak.cny.input, 3);
  assert.equal(peak.cny.cacheRead, 0.1);
  assert.equal(peak.cny.output, 9);
  const off = priceAt("deepseek-v4-flash", beijing(2026, 8, 20, 20));
  assert.equal(off.mode, "offPeak");
  assert.equal(off.cny.input, 1.5);
  assert.equal(off.cny.output, 4.5);
});

test("priceAt：V4 pro 峰谷价格", () => {
  const peak = priceAt("deepseek-v4-pro", beijing(2026, 8, 20, 9));
  assert.equal(peak.mode, "peak");
  assert.equal(peak.cny.input, 9);
  assert.equal(peak.cny.output, 27);
});

test("priceAt：2026-05-22 政策（75% 降价转永久）", () => {
  const unit = priceAt("deepseek-v4-flash", beijing(2026, 6, 1, 10));
  assert.equal(unit.mode, "flat");
  assert.equal(unit.cny.cacheRead, 0.02);
  assert.equal(unit.cny.input, 1);
  assert.equal(unit.cny.output, 2);
});

test("priceAt：2025 历史政策已删除，未审计区间一律未计价", () => {
  assert.equal(priceAt("deepseek-chat", beijing(2025, 8, 1)), null, "2025 夜间/调价历史未审计，不猜测");
  assert.equal(priceAt("deepseek-reasoner", beijing(2025, 8, 1)), null);
  assert.equal(priceAt("deepseek-chat", beijing(2026, 3, 1)), null, "alias 政策未生效前不猜测");
  assert.equal(priceAt("deepseek-chat", beijing(2026, 9, 1, 22)), null, "2026-07-24 退役后必须未计价");
});

test("priceAt：2026-04-24 ~ 07-24 旧 alias 按 V4-Flash 语义解析", () => {
  const alias = priceAt("deepseek-chat", beijing(2026, 6, 1, 10));
  const flash = priceAt("deepseek-v4-flash", beijing(2026, 6, 1, 10));
  assert.equal(alias.mode, "flat");
  assert.deepEqual(alias.cny, flash.cny);
  assert.deepEqual(alias.usd, flash.usd);
});

test("priceAt：未知模型 fail closed（返回 null，不再 wildcard 兜底）", () => {
  assert.equal(priceAt("some-future-model", beijing(2026, 9, 1, 22)), null);
  assert.equal(priceAt("deepseek-v5-ultra", beijing(2026, 9, 1, 22)), null);
});

test("priceAt：vendor 前缀与大小写归一后仍能命中已知模型", () => {
  const unit = priceAt("DeepSeek/deepseek-V4-Pro", beijing(2026, 8, 20, 10));
  assert.equal(unit.mode, "peak");
  assert.equal(unit.cny.input, 9);
});

test("costOf：原生币种与 USD 分开，不再返回模糊 cost", () => {
  const unit = { cny: { input: 1, cacheRead: 0.02, output: 2 }, usd: { input: 0.14, cacheRead: 0.0028, output: 0.28 } };
  const usage = { inputTokens: 1_000_000, cacheReadTokens: 2_000_000, outputTokens: 500_000 };
  const cny = costOf(usage, unit, "CNY");
  assert.equal(cny.costNative, 1 + 2 * 0.02 + 0.5 * 2); // 1 + 0.04 + 1 = 2.04
  assert.equal(cny.nativeCurrency, "CNY");
  assert.ok(Math.abs(cny.costUsd - (0.14 + 2 * 0.0028 + 0.5 * 0.28)) < 1e-9);
  assert.equal(cny.cost, undefined, "cost 模糊字段已取消");
  const usd = costOf(usage, unit, "USD");
  assert.ok(Math.abs(usd.costNative - usd.costUsd) < 1e-9, "USD 供应商 costNative === costUsd");
  assert.equal(usd.nativeCurrency, "USD");
});
