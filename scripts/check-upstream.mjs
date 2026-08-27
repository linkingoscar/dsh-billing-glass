/**
 * 上游漂移检测（无第三方依赖，可本地跑也可在 CI 定时跑）。
 *
 * 监控三类漂移，任一发生即写入报告并输出 `UPSTREAM_DRIFT: <n>` 标记：
 *  1. pi-ai 版本漂移：dsh 最新 release lockfile 的实际解析版本 vs 插件 devDep；
 *  2. 目录内容漂移：用上游版本的 pi-ai 数据重建目录 vs 已提交 catalog；
 *  3. DeepSeek 价格政策漂移：官方定价页 vs 内置政策链。
 *
 * 用法：
 *   node scripts/check-upstream.mjs [--strict] [--report <file.md>]
 * 默认只打印报告、退出码恒 0（定时任务不因上游变更而红）；`--strict` 下有漂移退出 1。
 * 网络/API 故障记为 "CHECK_FAILED"（可辨识但不误报为漂移）。
 *
 * Issue 自动化由 .github/workflows/upstream-watch.yml 完成：
 * 按 title 去重创建/追加「上游漂移检测」issue；无漂移时自动关闭遗留 issue。
 */
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const STRICT = process.argv.includes("--strict");
const reportIndex = process.argv.indexOf("--report");
const REPORT_FILE = reportIndex !== -1 ? process.argv[reportIndex + 1] : null;

const GITHUB_REPO = "deepseek-ai/deepseek-harness";
const PI_AI_PACKAGE = "@earendil-works/pi-ai";
const PRICING_PAGE = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";

const githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
const ghHeaders = githubToken !== "" ? { authorization: `Bearer ${githubToken}` } : {};

/** 漂移条目。
 * @typedef {{kind: string, detail: string}} DriftItem
 */
/** @type {DriftItem[]} */
const driftItems = [];
/** @type {{kind: string, error: string}[]} */
const failedChecks = [];

// ---- 契约哨兵（第 4 类检测：接缝文档/生成物 hash 基线，advisory 不计入 drift）----
const BASELINE_FILE = join(here, "upstream-sentinels.json");
const UPDATE_BASELINE = process.argv.includes("--update-baseline");

/** 哨兵锚点：这些文件的变动高度相关本插件的依赖契约。
 * @type {{key: string, path: string, label: string}[]}
 */
const CONTRACT_SENTINELS = [
  { key: "known-event-types", path: "packages/core/session/src/known-event-types.ts", label: "事件词汇表（回放依赖的事件全集）" },
  { key: "persistence-readme", path: "packages/session/session-persistence/README.md", label: "持久化契约（readRaw/supportsRawArtifacts）" },
  { key: "llm-types", path: "packages/llm/llm/src/types.ts", label: "TokenUsage / LLM 契约形状" },
  { key: "deepseek-readme", path: "packages/llm/llm-deepseek/README.md", label: "deepseek-official 路由与模型目录语义" }
];

/** 官方用量 API 迁移机会探测：关键词行集合的增量即信号。
 * @type {{key: string, path: string, pattern: RegExp}[]}
 */
const KEYWORD_SCANS = [
  { key: "llm-types", path: "packages/llm/llm/src/types.ts", pattern: /\b(usage|billing|cost|spend)\w*/gi },
  { key: "deepseek-readme", path: "packages/llm/llm-deepseek/README.md", pattern: /\b(usage|billing|cost|spend)\w*/gi }
];

/** 基线文件结构。
 * @typedef {{tag?: string, sentinels?: Record<string, {path: string, sha256: string}>, keywordLines?: Record<string, string[]>}} SentinelBaseline
 */

/**
 * @param {string} text
 * @returns {string}
 */
function sha256Of(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** @returns {SentinelBaseline|null} */
function readBaseline() {
  if (!existsSync(BASELINE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  } catch {
    return null;
  }
}

/** @param {SentinelBaseline} baseline */
function writeBaseline(baseline) {
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, "\t") + "\n", "utf8");
}

/** 提取关键词命中行集合（排序去重，截断长行）。
 * @param {string} text
 * @param {RegExp} pattern
 * @returns {string[]}
 */
function keywordLines(text, pattern) {
  /** @type {Set<string>} */
  const hits = new Set();
  for (const line of text.split("\n")) {
    pattern.lastIndex = 0;
    if (pattern.test(line)) {
      hits.add(line.trim().slice(0, 140));
    }
  }
  return [...hits].sort();
}

/** @type {DriftItem[]} */
const sentinelChanges = [];
/** @type {DriftItem[]} */
const migrationOpportunities = [];
/** @type {string|null} */
let baselineNotice = null;

/**
 * 抓取哨兵内容并对比基线；advisory —— 变化写入 sentinelChanges 而非 driftItems。
 * @param {string} tag 最新 release tag。
 */
async function checkContractSentinels(tag) {
  const current = /** @type {SentinelBaseline} */ ({ tag, sentinels: {}, keywordLines: {} });

  for (const sentinel of CONTRACT_SENTINELS) {
    const text = await fetchText(`https://raw.githubusercontent.com/${GITHUB_REPO}/${encodeURIComponent(tag)}/${sentinel.path}`);
    const sentinels = /** @type {NonNullable<SentinelBaseline["sentinels"]>} */ (current.sentinels);
    sentinels[sentinel.key] = { path: sentinel.path, sha256: sha256Of(text) };
    const scan = KEYWORD_SCANS.find((s) => s.key === sentinel.key);
    if (scan !== undefined) {
      const keywordLinesMap = /** @type {NonNullable<SentinelBaseline["keywordLines"]>} */ (current.keywordLines);
      keywordLinesMap[sentinel.key] = keywordLines(text, scan.pattern);
    }
  }

  const baseline = readBaseline();
  if (baseline === null || baseline.sentinels === undefined) {
    baselineNotice = "首次运行：哨兵基线不存在。确认报告无误后用 `node scripts/check-upstream.mjs --update-baseline` 建立基线。";
  } else {
    for (const sentinel of CONTRACT_SENTINELS) {
      const before = baseline.sentinels?.[sentinel.key];
      const after = current.sentinels?.[sentinel.key];
      if (after === undefined) continue;
      if (before === undefined) {
        sentinelChanges.push({ kind: "哨兵新增", detail: `${sentinel.label}\n  文件 ${sentinel.path} 首次纳入监控（${tag}）。` });
      } else if (before.sha256 !== after.sha256) {
        sentinelChanges.push({ kind: "哨兵变化", detail: `${sentinel.label}\n  文件 ${sentinel.path} 在 ${baseline.tag ?? "基线"} → ${tag} 之间发生变化。请人工复查是否影响插件依赖的契约（事件形状/持久化能力位/用量字段）。` });
      }
    }
    for (const removedKey of Object.keys(baseline.sentinels ?? {}).filter((k) => !CONTRACT_SENTINELS.some((s) => s.key === k))) {
      sentinelChanges.push({ kind: "哨兵移除", detail: `基线中的哨兵 \`${removedKey}\` 已不在监控清单中。` });
    }

    // 关键词增量 = 疑似官方用量/计费 API 出现（迁移机会，非漂移）。
    for (const scan of KEYWORD_SCANS) {
      const before = new Set(baseline.keywordLines?.[scan.key] ?? []);
      const after = current.keywordLines?.[scan.key] ?? [];
      const added = after.filter((line) => !before.has(line));
      if (added.length > 0) {
        migrationOpportunities.push({
          kind: "官方用量 API 信号",
          detail: `\`${scan.path}\` 新增 usage/billing/cost/spend 相关行 ${added.length} 条（前 3 条）：\n${added.slice(0, 3).map((l) => `  + ${l}`).join("\n")}\n若为正式用量/计费接口，请评估整体迁移、弃用定价页爬虫。`
        });
      }
    }
  }

  if (UPDATE_BASELINE) {
    writeBaseline(current);
    baselineNotice = (baselineNotice === null ? "" : baselineNotice + " ") + `已写入新基线（${tag}）→ scripts/upstream-sentinels.json`;
  }
}


/**
 * @param {string} url
 * @returns {Promise<any>}
 */
async function fetchJson(url) {
  const res = await fetch(url, { headers: /** @type {Record<string, string>} */ ({ ...ghHeaders, "user-agent": "dsh-billing-glass-upstream-watch" }) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "dsh-billing-glass-upstream-watch" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** 极简 semver：支持精确版本与 ^ / ~ 区间（本仓库 devDep 只用这两种写法）。
 * @param {string} version
 * @returns {[number, number, number]|null}
 */
function parseVersion(version) {
  const parts = String(version).split(".").map((n) => Number.parseInt(n, 10));
  return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? /** @type {[number, number, number]} */ (parts) : null;
}

/**
 * @param {string} version
 * @param {string} range
 * @returns {boolean}
 */
function satisfiesRange(version, range) {
  const v = parseVersion(version);
  if (v === null) return false;
  const trimmed = String(range).trim();
  if (/^\d+\.\d+\.\d+$/.test(trimmed)) return version === trimmed;
  const match = /^(\^|~)(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (match === null) return false;
  const [, op, majS, minS, patS] = match;
  const base = [Number(majS), Number(minS), Number(patS)];
  const geBase = v[0] > base[0]
    || (v[0] === base[0] && v[1] > base[1])
    || (v[0] === base[0] && v[1] === base[1] && v[2] >= base[2]);
  if (!geBase) return false;
  if (op === "^") {
    if (base[0] > 0) return v[0] === base[0];
    return v[0] === 0 && v[1] === base[1]; // ^0.x.y 锁 minor
  }
  return v[0] === base[0] && v[1] === base[1]; // ~ 锁 minor
}

async function checkPiAiVersionDrift() {
  const releases = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=10`);
  const latest = Array.isArray(releases) ? releases.find((r) => r?.draft !== true) : null;
  if (latest?.tag_name === undefined) throw new Error("no non-draft release found");
  const tag = latest.tag_name;

  const manifest = JSON.parse(await fetchText(
    `https://raw.githubusercontent.com/${GITHUB_REPO}/${encodeURIComponent(tag)}/packages/llm/llm-pi-ai/package.json`
  ));
  const range = manifest?.dependencies?.[PI_AI_PACKAGE];
  if (typeof range !== "string" || range === "") throw new Error("harness llm-pi-ai has no pi-ai dependency");

  // 版本范围会随 npm 新发布继续漂移；release 的真实依赖应以该 tag 的 lockfile 为准。
  const lockfile = await fetchText(
    `https://raw.githubusercontent.com/${GITHUB_REPO}/${encodeURIComponent(tag)}/pnpm-lock.yaml`
  );
  const packagePattern = PI_AI_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const versions = [...lockfile.matchAll(new RegExp(`^\\s{2}'${packagePattern}@(\\d+\\.\\d+\\.\\d+)':\\s*$`, "gm"))]
    .map((match) => match[1])
    .filter((version) => satisfiesRange(version, range));
  if (versions.length === 0) throw new Error(`tag ${tag} lockfile has no ${PI_AI_PACKAGE} version satisfying ${range}`);
  versions.sort((a, b) => {
    const pa = /** @type {[number, number, number]} */ (parseVersion(a));
    const pb = /** @type {[number, number, number]} */ (parseVersion(b));
    return (pb[0] - pa[0]) || (pb[1] - pa[1]) || (pb[2] - pa[2]);
  });
  const upstreamVersion = versions[0];

  const pluginManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pinned = pluginManifest?.devDependencies?.[PI_AI_PACKAGE];
  if (typeof pinned !== "string") throw new Error("plugin package.json missing pi-ai devDependency");

  const normalize = (/** @type {string} */ v) => String(v).replace(/^[\^~]/, "");
  if (normalize(pinned) !== upstreamVersion) {
    driftItems.push({
      kind: "pi-ai 版本",
      detail: `Harness ${tag} 需要 ${PI_AI_PACKAGE}@${range}（lockfile 解析为 ${upstreamVersion}），插件 devDep 锁定 ${pinned}。请升级 devDep 并重跑 \`node scripts/sync-providers.js\` 同步目录。`
    });
  }
  return { tag, range, upstreamVersion, pinned };
}

/** npm pack 上游版本的数据包，解包后用与 sync-providers 相同的构建器重建目录。
 * @param {string} upstreamVersion
 */
async function checkCatalogDrift(upstreamVersion) {
  const tmp = mkdtempSync(join(tmpdir(), "billing-glass-upstream-"));
  try {
    // 包名/版本均来自 registry 元数据且版本号已过 parseVersion 校验（纯数字），
    // 无注入面；Windows 下 npm 需要 shell，统一走 execSync 字符串形式。
    execSync(`npm pack ${PI_AI_PACKAGE}@${upstreamVersion} --pack-destination "${tmp}"`, {
      cwd: root, stdio: "pipe"
    });
    const tgz = join(tmp, `${PI_AI_PACKAGE.replace("@", "").replace("/", "-")}-${upstreamVersion}.tgz`);
    if (!existsSync(tgz)) throw new Error(`npm pack output not found: ${tgz}`);
    execSync(`tar -xzf "${tgz}" -C "${tmp}"`, { stdio: "pipe" });

    const dataDir = join(tmp, "package", "dist", "providers", "data");
    const packageDir = join(tmp, "package");
    if (!existsSync(dataDir)) throw new Error(`upstream tarball has no providers data dir (${dataDir})`);

    const { buildCatalogFromData } = await import(pathToFileURL(join(root, "scripts", "sync-providers.js")).href);
    const { catalog } = buildCatalogFromData(dataDir, packageDir);

    const committedModule = await import(pathToFileURL(join(root, "lib", "providers", "catalog.generated.js")).href);
    const committed = committedModule.PI_AI_CATALOG;

    const committedIds = new Set(committed.map((/** @type {{id: string}} */ p) => p.id));
    const upstreamIds = new Set(catalog.map((/** @type {{id: string}} */ p) => p.id));
    const added = [...upstreamIds].filter((id) => !committedIds.has(id));
    const removed = [...committedIds].filter((id) => !upstreamIds.has(id));

    /** @type {string[]} */
    let priceChanged = [];
    for (const up of catalog) {
      const local = committed.find((/** @type {{id: string}} */ p) => p.id === up.id);
      if (local === void 0) continue;
      if (JSON.stringify(local.models) !== JSON.stringify(up.models)) priceChanged.push(up.id);
    }

    if (added.length > 0 || removed.length > 0 || priceChanged.length > 0) {
      const parts = [];
      if (added.length > 0) parts.push(`新增 provider：${added.join(", ")}`);
      if (removed.length > 0) parts.push(`移除 provider：${removed.join(", ")}`);
      if (priceChanged.length > 0) parts.push(`模型/价格变化：${priceChanged.join(", ")}`);
      driftItems.push({ kind: "目录内容", detail: `上游 pi-ai@${upstreamVersion} 数据与已提交目录不一致 —— ${parts.join("；")}。请运行 \`node scripts/sync-providers.js\` 后提交更新。` });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function checkPricingPolicyDrift() {
  const html = await fetchText(PRICING_PAGE);
  const refreshModule = await import(pathToFileURL(join(root, "lib", "providers", "deepseek-refresh.js")).href);
  const report = refreshModule.compareWithBuiltin(refreshModule.parseOfficialPage(html));
  if (report.status === "changed") {
    driftItems.push({
      kind: "DeepSeek 价格政策",
      detail: `官方定价页与内置政策链出现差异：\n${report.details.map((/** @type {string} */ d) => `  - ${d}`).join("\n")}\n请核对 api-docs.deepseek.com 后更新 lib/providers/deepseek-pricing.js（必要时刷新 tests/fixtures 快照）。`
    });
  } else if (report.status === "unavailable") {
    driftItems.push({
      kind: "DeepSeek 价格政策",
      detail: "官方定价页结构变化导致无法解析（fail closed）。请人工查看定价页并同步解析器 deepseek-refresh.js。"
    });
  }
}

/** 渲染 markdown 报告。
 * @param {{tag?: string, range?: string, upstreamVersion?: string, pinned?: string}} meta
 * @returns {string}
 */
function renderReport(meta) {
  const lines = [];
  lines.push("# 上游漂移检测报告");
  lines.push("");
  lines.push(`- 运行时间：${new Date().toISOString()}`);
  if (meta?.tag !== undefined) lines.push(`- Harness 最新 release：\`${meta.tag}\`（pi-ai 需求 \`${meta.range}\`，lockfile → ${meta.upstreamVersion}；插件锁定 \`${meta.pinned}\`）`);
  lines.push("");
  if (driftItems.length === 0) {
    lines.push("✅ 无漂移：pi-ai 版本、目录内容、DeepSeek 价格政策均与上游一致。");
  } else {
    lines.push(`⚠️ 发现 ${driftItems.length} 类漂移：`);
    lines.push("");
    for (const item of driftItems) {
      lines.push(`## ${item.kind}`);
      lines.push("");
      lines.push(item.detail);
      lines.push("");
    }
  }
  if (sentinelChanges.length > 0) {
    lines.push(`## 契约哨兵变化（${sentinelChanges.length}，人工复查）`);
    lines.push("");
    for (const item of sentinelChanges) {
      lines.push(`### ${item.kind}`);
      lines.push("");
      lines.push(item.detail);
      lines.push("");
    }
  }
  if (migrationOpportunities.length > 0) {
    lines.push(`## 迁移机会（${migrationOpportunities.length}）`);
    lines.push("");
    for (const item of migrationOpportunities) {
      lines.push(`### ${item.kind}`);
      lines.push("");
      lines.push(item.detail);
      lines.push("");
    }
  }
  if (baselineNotice !== null) {
    lines.push(`> ℹ️ ${baselineNotice}`);
    lines.push("");
  }
  if (failedChecks.length > 0) {
    lines.push("> ⚠️ 以下检查项本身执行失败（网络/API 问题，非价格漂移），建议手动复核：");
    for (const f of failedChecks) lines.push(`> - ${f.kind}: ${f.error}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function main() {
  /** @type {{tag?: string, range?: string, upstreamVersion?: string, pinned?: string}} */
  let meta = {};
  await run("pi-ai 版本", async () => { meta = await checkPiAiVersionDrift(); });
  await run("目录内容", async () => { await checkCatalogDrift(/** @type {string} */ (meta.upstreamVersion)); }, meta.upstreamVersion === undefined);
  await run("DeepSeek 价格政策", async () => { await checkPricingPolicyDrift(); });
  await run("契约哨兵", async () => { await checkContractSentinels(/** @type {string} */ (meta.tag)); }, meta.tag === undefined);

  const report = renderReport(meta);
  console.log(report);
  console.log(`UPSTREAM_DRIFT: ${driftItems.length}`);
  console.log(`CONTRACT_SENTINEL_CHANGES: ${sentinelChanges.length}`);
  if (REPORT_FILE !== null && REPORT_FILE !== undefined) writeFileSync(REPORT_FILE, report + "\n", "utf8");
  if (STRICT && driftItems.length > 0) process.exit(1);
}

/** 单项执行包装：失败记 CHECK_FAILED，不中断其余检查项。
 * @param {string} kind
 * @param {() => Promise<void>} fn
 * @param {boolean=} skip
 */
async function run(kind, fn, skip = false) {
  if (skip) {
    failedChecks.push({ kind, error: "前置检查失败，跳过" });
    return;
  }
  try {
    await fn();
  } catch (error) {
    failedChecks.push({ kind, error: error instanceof Error ? error.message : String(error) });
  }
}

main().catch((error) => {
  console.error("check-upstream: fatal", error);
  process.exit(2);
});
