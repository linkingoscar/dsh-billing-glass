// 官方定价页解析与对比验证（夹具为 2026-08 抓取的真实页面快照：三列峰谷矩阵）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOfficialPage, compareWithBuiltin, htmlToText } from "../lib/providers/deepseek-refresh.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(__dirname, "fixtures", "ds-pricing-2026-08.html"), "utf8");
const currentFixture = readFileSync(join(__dirname, "fixtures", "ds-pricing-2026-09.html"), "utf8");
const august = Date.parse("2026-08-23T10:00:00+08:00");
const september = Date.parse("2026-09-11T10:00:00+08:00");

test("htmlToText 去标签折叠空白", () => {
  const text = htmlToText("<div>a  <b>b</b><script>x</script> c&nbsp;d</div>");
  assert.equal(text.trim(), "a b c d");
});

test("parseOfficialPage 解析三列峰谷矩阵（flash / pro / vision-exp）", () => {
  const parsed = parseOfficialPage(fixture);
  assert.ok(parsed !== null, "真实页面应可解析");
  assert.deepEqual(parsed.peak["deepseek-v4-flash"].offPeak, { cacheRead: 0.05, input: 1.5, output: 4.5 });
  assert.deepEqual(parsed.peak["deepseek-v4-flash"].peak, { cacheRead: 0.1, input: 3, output: 9 });
  assert.deepEqual(parsed.peak["deepseek-v4-pro"].offPeak, { cacheRead: 0.15, input: 4.5, output: 13.5 });
  assert.deepEqual(parsed.peak["deepseek-v4-pro"].peak, { cacheRead: 0.3, input: 9, output: 27 });
  // vision-exp 列与 flash 同价
  assert.deepEqual(parsed.peak["deepseek-v4-flash-vision-exp"], parsed.peak["deepseek-v4-flash"]);
  // 新版页面不再声明生效日期
  assert.equal(parsed.effectiveAt, null);
});

test("compareWithBuiltin：官方页与内置政策链一致 → current", () => {
  const report = compareWithBuiltin(parseOfficialPage(fixture), august);
  assert.equal(report.status, "current");
});

test("compareWithBuiltin：价格漂移 → changed 并给出差异明细", () => {
  const parsed = parseOfficialPage(fixture);
  parsed.peak["deepseek-v4-flash"].peak.input = 9.9; // 模拟官方调价
  const report = compareWithBuiltin(parsed, august);
  assert.equal(report.status, "changed");
  assert.ok(report.details.some((d) => d.includes("高峰 input") && d.includes("9.9")));
});

test("compareWithBuiltin：内置模型在官方页缺失 → changed", () => {
  const parsed = parseOfficialPage(fixture);
  delete parsed.peak["deepseek-v4-flash-vision-exp"];
  const report = compareWithBuiltin(parsed, august);
  assert.equal(report.status, "changed");
  assert.ok(report.details.some((d) => d.includes("vision-exp") && d.includes("未能从官方页面解析")));
});

test("compareWithBuiltin：生效日期变化 → changed；双侧无日期则跳过", () => {
  const parsed = parseOfficialPage(fixture);
  parsed.effectiveAt = "2026-09-01";
  const report = compareWithBuiltin(parsed, august);
  assert.equal(report.status, "changed");
  assert.ok(report.details.some((d) => d.includes("2026-09-01")));
  assert.equal(compareWithBuiltin({ peak: structuredClone(parseOfficialPage(fixture).peak), effectiveAt: null }, august).status, "current");
});

test("September two-column page matches current policy; August page reports drift", () => {
  const parsed = parseOfficialPage(currentFixture);
  assert.deepEqual(parsed.peak["deepseek-flash"], {
    offPeak: { cacheRead: 0.02, input: 1, output: 4 },
    peak: { cacheRead: 0.04, input: 2, output: 8 }
  });
  assert.equal(compareWithBuiltin(parsed, september).status, "current");
  assert.equal(compareWithBuiltin(parseOfficialPage(fixture), september).status, "changed");
});

test("Column order and new model names come from the header, not a fixed whitelist", () => {
  const reordered = currentFixture.replaceAll("deepseek-flash", "temporary-model")
    .replaceAll("deepseek-v4-pro", "deepseek-flash").replaceAll("temporary-model", "deepseek-v4-pro");
  const parsed = parseOfficialPage(reordered);
  assert.equal(parsed.peak["deepseek-v4-pro"].peak.input, 2);
  assert.equal(parsed.peak["deepseek-flash"].peak.input, 9);
  const added = parseOfficialPage(currentFixture.replaceAll("deepseek-v4-pro", "deepseek-future"));
  assert.equal(added.peak["deepseek-future"].peak.input, 9);
  assert.ok(compareWithBuiltin(added, september).details.some(d => d.includes("deepseek-future 官方新增")));
});

test("A Pro availability footnote is not a pricing effective date", () => {
  assert.equal(parseOfficialPage(currentFixture + "<p>2026 年 9 月 14 日之后继续提供 Pro，计费方式保持不变。</p>").effectiveAt, null);
  assert.equal(parseOfficialPage(currentFixture + "<p>上述定价于 2026 年 9 月 10 日生效。</p>").effectiveAt, "2026-09-10");
});

test("parseOfficialPage：旧两列布局 fail closed 返回 null", () => {
  const legacy = `<html><body><table>
    <tr><td>模型</td><td>deepseek-v4-flash</td><td>deepseek-v4-pro</td></tr>
    <tr><td>百万tokens输入（缓存命中）</td><td>0.02元</td><td>0.025元</td></tr>
  </table></body></html>`;
  assert.equal(parseOfficialPage(legacy), null, "旧布局缺少峰谷矩阵，必须返回 null 引导对话处理");
});

test("compareWithBuiltin：解析失败 → unavailable", () => {
  assert.equal(compareWithBuiltin(null).status, "unavailable");
  assert.equal(compareWithBuiltin(parseOfficialPage("<html>页面改版了</html>")).status, "unavailable");
});
