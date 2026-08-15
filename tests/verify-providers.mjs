// 供应商自动识别验证：provider id 别名 + baseURL hostname 两级匹配，
// 以及官方目录驱动的预置供应商结构。
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchProvider, PROVIDERS } from "../lib/providers/registry.js";
import { PI_AI_CATALOG_META, defineOpenAiCompatProvider } from "../lib/providers/openai-compat.js";

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

test("官方目录计价：USD 供应商 costNative === costUsd === 目录价", () => {
  const provider = matchProvider("pi-ai", "https://api.x.ai/v1");
  assert.equal(provider.id, "xai");
  assert.equal(provider.currency, "USD");
  const unit = provider.priceAt("grok-4.3", Date.now());
  assert.equal(unit.mode, "flat");
  const catalogInput = unit.usd.input;
  assert.ok(catalogInput > 0, "目录价应大于 0");
  const result = provider.costOf({ inputTokens: 1_000_000, outputTokens: 0 }, unit);
  assert.ok(Math.abs(result.costNative - catalogInput) < 1e-9, "costNative 应为 USD 目录价，而不是 7.2 汇率换算后的 CNY");
  assert.ok(Math.abs(result.costUsd - catalogInput) < 1e-9);
  assert.equal(result.nativeCurrency, "USD");
});

test("未知模型 fail closed：返回 null，绝不按 0 元计费", () => {
  const provider = matchProvider("pi-ai", "https://api.moonshot.cn/v1");
  assert.equal(provider.priceAt("brand-new-model-not-in-catalog", Date.now()), null);
  assert.equal(provider.priceAt("kimi-k2-turbo-preview", Date.now()) !== null, true);
});

test("带 / 的合法 catalog model id：exact 命中不被 basename strip 破坏", () => {
  const baseten = PROVIDERS.find((p) => p.id === "baseten");
  assert.ok(baseten, "baseten provider 存在");
  assert.ok(baseten.priceAt("deepseek-ai/DeepSeek-V4-Pro", Date.now()) !== null, "完整 catalog id 应命中");
  assert.ok(baseten.priceAt("DEEPSEEK-AI/deepseek-v4-pro", Date.now()) !== null, "完整 id 大小写不敏感命中");
  assert.ok(baseten.priceAt("moonshotai/Kimi-K3", Date.now()) !== null, "另一个带 / 的 catalog id 应命中");
});

test("basename alias 只在唯一匹配时使用；歧义 fail closed", () => {
  const provider = defineOpenAiCompatProvider({
    id: "ambiguity-test",
    displayName: "Ambiguity Test",
    baseUrl: "https://ambiguity.example/v1",
    baseUrlHosts: ["ambiguity.example"],
    prices: {
      "foo/model-x": { input: 1, cacheRead: 0.1, output: 2 },
      "bar/model-x": { input: 3, cacheRead: 0.3, output: 6 }
    },
    planLabel: "test"
  });
  assert.ok(provider.priceAt("foo/model-x", Date.now()) !== null, "exact 完整 id 命中");
  assert.ok(provider.priceAt("FOO/MODEL-X", Date.now()) !== null, "大小写不敏感 exact 命中");
  assert.equal(provider.priceAt("model-x", Date.now()), null, "裸 basename 有歧义，必须 fail closed");
});

test("有余额适配器的供应商 keyRef 正确；其余家余额返回 null 不抛错", async () => {
  const withBalance = matchProvider("pi-ai", "https://openrouter.ai/api/v1");
  assert.equal(withBalance.keyRef, "OPENROUTER_API_KEY");
  const noBalance = matchProvider("pi-ai", "https://api.x.ai/v1");
  assert.equal(await noBalance.fetchBalance({}), null, "无公开余额接口的供应商返回 null");
});

test("目录血缘元数据必须真实：version/hash/generatedAt 禁止为 null", () => {
  assert.equal(PI_AI_CATALOG_META.source, "@earendil-works/pi-ai dist/providers/data + dist/providers/<id>.js");
  assert.equal(PI_AI_CATALOG_META.generator, "scripts/sync-providers.js");
  assert.ok(typeof PI_AI_CATALOG_META.sourceVersion === "string" && PI_AI_CATALOG_META.sourceVersion !== "", "sourceVersion 必须记录真实版本");
  assert.match(PI_AI_CATALOG_META.sourceSha256, /^[a-f0-9]{64}$/, "sourceSha256 必须是 64 位 hex");
  assert.ok(Number.isFinite(Date.parse(PI_AI_CATALOG_META.generatedAt)), "generatedAt 必须是合法时间");
});
