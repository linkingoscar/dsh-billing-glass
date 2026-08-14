// 供应商自动识别验证：provider id 别名 + baseURL hostname 两级匹配，
// 以及官方目录驱动的预置供应商结构。
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchProvider, PROVIDERS } from "../lib/providers/registry.js";

test("注册表 = DeepSeek 专用 + 官方目录预置供应商（对齐 Harness 提供方列表）", () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.equal(ids[0], "deepseek", "DeepSeek 保持第一位（优先）");
  assert.ok(ids.includes("moonshotai-cn"));
  assert.ok(ids.includes("moonshotai"));
  assert.ok(ids.includes("openrouter"));
  assert.ok(ids.includes("xai"));
  assert.ok(ids.includes("groq"));
  assert.ok(ids.length >= 20, `官方目录预置应不少于 20 家，实际 ${ids.length}`);
  // 不在官方目录的供应商不应出现在预置里
  assert.ok(!ids.includes("siliconflow"));
});

test("provider id 别名匹配", () => {
  assert.equal(matchProvider("deepseek-official")?.id, "deepseek");
  assert.equal(matchProvider("pi-ai"), null, "pi-ai 本身不是供应商");
});

test("pi-ai 网关 baseURL hostname 自动识别官方目录供应商", () => {
  assert.equal(matchProvider("pi-ai", "https://api.moonshot.cn/v1")?.id, "moonshotai-cn");
  assert.equal(matchProvider("pi-ai", "https://api.moonshot.ai/v1")?.id, "moonshotai");
  assert.equal(matchProvider("pi-ai", "https://openrouter.ai/api/v1")?.id, "openrouter");
  assert.equal(matchProvider("pi-ai", "https://api.deepseek.com")?.id, "deepseek");
});

test("未知 baseURL 不误配（留给前端引导用户提供计价方案）", () => {
  assert.equal(matchProvider("pi-ai", "https://unknown.example.com/v1"), null);
  assert.equal(matchProvider("pi-ai"), null);
});

test("预置供应商有完整契约（计价、套餐；余额按适配器可无）", () => {
  for (const p of PROVIDERS) {
    assert.equal(typeof p.id, "string");
    assert.equal(typeof p.priceAt, "function");
    assert.equal(typeof p.costOf, "function");
    assert.equal(typeof p.fetchBalance, "function");
    assert.ok(p.plan && typeof p.plan.label === "string");
    assert.ok(Array.isArray(p.baseUrlHosts) && p.baseUrlHosts.length > 0, `${p.id} 应有 baseUrl hostname 供识别`);
  }
});

test("官方目录计价：USD 目录价双币种换算", () => {
  const provider = matchProvider("pi-ai", "https://api.moonshot.cn/v1");
  assert.equal(provider.id, "moonshotai-cn");
  const unit = provider.priceAt("kimi-k2-turbo-preview", Date.now());
  assert.equal(unit.mode, "flat");
  assert.equal(unit.usd.input, 2.4); // 目录价（USD/1M）
  const result = provider.costOf({ inputTokens: 1_000_000, outputTokens: 0 }, unit);
  assert.ok(Math.abs(result.costUsd - 2.4) < 1e-9);
});

test("有余额适配器的供应商 keyRef 正确；其余家余额返回 null 不抛错", async () => {
  const withBalance = matchProvider("pi-ai", "https://openrouter.ai/api/v1");
  assert.equal(withBalance.keyRef, "OPENROUTER_API_KEY");
  const noBalance = matchProvider("pi-ai", "https://api.x.ai/v1");
  assert.equal(await noBalance.fetchBalance({}), null, "无公开余额接口的供应商返回 null");
});
