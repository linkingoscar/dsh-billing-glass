// 型号代称纯函数验证（展示层，不影响计费）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelBadgeFor } from "../src/client/model-badge.js";

const deepseek = { id: "deepseek" };

test("DeepSeek 系列：Pro / Flash / Flash-Vision", () => {
  assert.equal(modelBadgeFor(deepseek, "deepseek-v4-pro"), "Pro");
  assert.equal(modelBadgeFor(deepseek, "deepseek-v4-flash"), "Flash");
  // 视觉实验模型：先判 vision 再判 flash
  assert.equal(modelBadgeFor(deepseek, "deepseek-v4-flash-vision-exp"), "Flash-Vision");
  assert.equal(modelBadgeFor(deepseek, "DEEPSEEK/deepseek-v4-flash-vision-exp"), "Flash-Vision", "带 vendor 前缀仍命中");
});

test("Kimi 系列：版本号 + 可选后缀", () => {
  assert.equal(modelBadgeFor(null, "kimi-k2.5"), "K2.5");
  assert.equal(modelBadgeFor(null, "moonshotai/kimi-k3"), "K3");
  const badge = modelBadgeFor(null, "kimi-k2.7-code");
  assert.ok(badge !== null && badge.startsWith("K2.7"), `kimi code 后缀应保留版本号，实际 ${badge}`);
});

test("GPT 系列：版本 + 已知变体", () => {
  const luna = modelBadgeFor(null, "gpt-5.6-luna");
  assert.ok(luna !== null && luna.includes("Luna"), `luna 变体应识别，实际 ${luna}`);
  assert.equal(modelBadgeFor(null, "gpt-4o-mini"), "4o-Mini");
});

test("Claude / Gemini / Qwen / GLM 系列", () => {
  const opus = modelBadgeFor(null, "claude-opus-4");
  assert.ok(opus !== null && opus.startsWith("Opus-4"), `claude 应识别 Opus-4，实际 ${opus}`);
  const gem = modelBadgeFor(null, "gemini-2.5-pro");
  assert.ok(gem !== null && gem.includes("Pro") && gem.includes("2.5"), `gemini 应含 2.5/Pro，实际 ${gem}`);
  const qwen = modelBadgeFor(null, "qwen3.7-max");
  assert.ok(qwen !== null && qwen.includes("Max"), `qwen max 应识别，实际 ${qwen}`);
  const glm = modelBadgeFor(null, "glm-4.7-flash");
  assert.ok(glm !== null && glm.includes("Flash"), `glm flash 应识别，实际 ${glm}`);
});

test("兜底 tier 与 series；空输入返回 null（fail-soft）", () => {
  assert.equal(modelBadgeFor(null, "some-model-ultra"), "Ultra");
  const series = modelBadgeFor(null, "mistral-large");
  assert.ok(series !== null && series !== "", "series 兜底应有输出");
  assert.equal(modelBadgeFor(null, ""), null);
  assert.equal(modelBadgeFor(null, undefined), null);
});
