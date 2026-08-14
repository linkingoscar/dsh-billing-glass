// 官方定价页解析与对比验证（夹具为 2026-08 抓取的真实页面快照）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOfficialPage, compareWithBuiltin, htmlToText } from "../lib/providers/deepseek-refresh.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, "fixtures", "ds-pricing-2026-08.html"), "utf8");

test("htmlToText 去标签折叠空白", () => {
  const text = htmlToText("<div>a  <b>b</b><script>x</script> c&nbsp;d</div>");
  assert.equal(text.trim(), "a b c d");
});

test("parseOfficialPage 提取现行价与峰谷表", () => {
  const parsed = parseOfficialPage(fixture);
  assert.ok(parsed !== null, "真实页面应可解析");
  assert.deepEqual(parsed.current["deepseek-v4-flash"], { cacheRead: 0.02, input: 1, output: 2 });
  assert.deepEqual(parsed.current["deepseek-v4-pro"], { cacheRead: 0.025, input: 3, output: 6 });
  assert.deepEqual(parsed.peak["deepseek-v4-flash"].offPeak, { cacheRead: 0.05, input: 1.5, output: 4.5 });
  assert.deepEqual(parsed.peak["deepseek-v4-flash"].peak, { cacheRead: 0.1, input: 3, output: 9 });
  assert.deepEqual(parsed.peak["deepseek-v4-pro"].peak, { cacheRead: 0.3, input: 9, output: 27 });
  assert.equal(parsed.effectiveAt, "2026-08-17");
});

test("compareWithBuiltin：官方页与内置政策链一致 → current", () => {
  const report = compareWithBuiltin(parseOfficialPage(fixture));
  assert.equal(report.status, "current");
});

test("compareWithBuiltin：价格漂移 → changed 并给出差异明细", () => {
  const parsed = parseOfficialPage(fixture);
  parsed.current["deepseek-v4-flash"].output = 2.5; // 模拟官方调价
  const report = compareWithBuiltin(parsed);
  assert.equal(report.status, "changed");
  assert.ok(report.details.some((d) => d.includes("output") && d.includes("2.5")));
});

test("compareWithBuiltin：生效日期变化 → changed", () => {
  const parsed = parseOfficialPage(fixture);
  parsed.effectiveAt = "2026-09-01";
  const report = compareWithBuiltin(parsed);
  assert.equal(report.status, "changed");
  assert.ok(report.details.some((d) => d.includes("2026-09-01")));
});

test("compareWithBuiltin：解析失败 → unavailable", () => {
  assert.equal(compareWithBuiltin(null).status, "unavailable");
  assert.equal(compareWithBuiltin(parseOfficialPage("<html>页面改版了</html>")).status, "unavailable");
});
