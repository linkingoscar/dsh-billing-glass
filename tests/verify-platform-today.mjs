// 平台用量接口解析验证（官方今日消费）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlatformTodayCost } from "../lib/providers/deepseek.js";

const TODAY = "2026-08-14";

function envelope(days) {
  return { code: 0, data: { biz_code: 0, biz_data: { days } } };
}

test("正常响应：今天一行多模型求和（含字符串数字与 amount 兜底）", () => {
  const body = envelope([
    { date: "2026-08-13", data: [{ usage: [{ cost: 9.99 }] }] },
    {
      date: TODAY,
      data: [
        { usage: [{ cost: "1.25" }, { amount: "0.5" }] },
        { usage: [{ cost: 2 }] }
      ]
    }
  ]);
  assert.equal(parsePlatformTodayCost(body, TODAY), 3.75);
});

test("今天无行 → null（调用方回退余额差估算）", () => {
  const body = envelope([{ date: "2026-08-13", data: [{ usage: [{ cost: 1 }] }] }]);
  assert.equal(parsePlatformTodayCost(body, TODAY), null);
});

test("结构不符 → null 或明确报错（调用方回退余额差估算）", () => {
  assert.equal(parsePlatformTodayCost({ code: 0, data: { biz_code: 0, biz_data: {} } }, TODAY), null);
  assert.throws(() => parsePlatformTodayCost(null, TODAY), /平台用量接口错误/);
});

test("业务错误码 → throw（token 过期给出明确提示）", () => {
  assert.throws(
    () => parsePlatformTodayCost({ code: 40002, data: null }, TODAY),
    /DEEPSEEK_PLATFORM_TOKEN 已过期/
  );
  assert.throws(
    () => parsePlatformTodayCost({ code: 500, data: null }, TODAY),
    /平台用量接口错误/
  );
});
