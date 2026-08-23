/**
 * 从 Harness 内置的 pi-ai 供应商目录生成 lib/providers/catalog.generated.js。
 *
 * pi-ai（@earendil-works/pi-ai）是 Harness 模型配置后台"提供方列表"的来源，
 * 其 dist/providers/data/*.json 对每个供应商维护官方模型目录与价格
 * （cost 字段，USD / 1M tokens，已按 deepseek-v4-flash 官方价校准）。
 * 本脚本把「openai-completions 协议 + 带价格」的供应商提取成插件内置目录，
 * 使预置供应商与 Harness 官方列举完全对齐；Harness 升级后重跑本脚本即可同步。
 *
 * 用法：
 *   node scripts/sync-providers.js [--pi-ai-dir <path/to/pi-ai/dist/providers/data>] [--check]
 * 数据源探测顺序：--pi-ai-dir > 本地 Harness 安装 > 插件自身 devDep（见 findSource）。
 * 默认自动探测；`buildCatalogFromData` 同时导出给 scripts/check-upstream.mjs 复用。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "lib", "providers", "catalog.generated.js");
// `--check` 供 CI 使用：generatedAt / sourceKind 继承已提交文件，重新生成后由外层 git diff 验证。
const CHECK_MODE = process.argv.includes("--check");

/**
 * 定位 pi-ai 数据目录与包根目录（用于记录 version + source hash 血缘）。
 * 探测顺序：显式 --pi-ai-dir > 本地 Harness 安装（与宿主实际捆绑版本一致）
 * > 插件自身 devDep。返回值带 sourceKind 供数据血缘记录。
 */
export function findSource(argv = process.argv) {
  const argIndex = argv.indexOf("--pi-ai-dir");
  if (argIndex !== -1 && argv[argIndex + 1]) {
    const dataDir = resolve(argv[argIndex + 1]);
    return { dataDir, packageDir: resolve(dataDir, "../../.."), sourceKind: "explicit-arg" };
  }
  // 本地 Harness 安装优先：与 dsh 实际捆绑的 pi-ai 完全一致，
  // 避免 devDep 版本漂移导致"插件列表 ≠ Harness 设置页列表"。
  const candidates = [];
  if (process.env.DSH_HARNESS_NODE_MODULES) {
    candidates.push(join(process.env.DSH_HARNESS_NODE_MODULES, "@earendil-works", "pi-ai"));
  }
  candidates.push(join(homedir(), ".dsh", "profiles", "node_modules", "@earendil-works", "pi-ai"));
  for (const packageDir of candidates) {
    const dataDir = join(packageDir, "dist", "providers", "data");
    if (existsSync(dataDir)) return { dataDir, packageDir, sourceKind: "harness-install" };
  }
  try {
    // 插件自身 node_modules 的包根目录（devDep 兜底）。
    const packageDir = resolve(here, "..", "node_modules", "@earendil-works", "pi-ai");
    const dataDir = join(packageDir, "dist", "providers", "data");
    if (existsSync(dataDir)) return { dataDir, packageDir, sourceKind: "dev-dependency" };
  } catch { /* ignore */ }
  return null;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function toFinite(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 目录条目（与 lib/providers/openai-compat.js 的 CatalogEntry 同构）。
 * @typedef {{id: string, displayName: string|null, baseUrl: string|null, models: Record<string, {input: number, cacheRead: number, output: number}>}} SyncCatalogEntry
 */

/**
 * 从 pi-ai 数据目录构建插件内置目录（纯读取，无副作用）。
 * @param {string} dataDir pi-ai 的 dist/providers/data 目录。
 * @param {string} packageDir pi-ai 包根目录。
 * @returns {{ catalog: SyncCatalogEntry[], sourceVersion: string|null, sourceSha256: string }}
 */
export function buildCatalogFromData(dataDir, packageDir) {
  // 数据血缘：pi-ai 包版本 + 数据文件 SHA-256 + provider JS 内容一并纳入。
  let sourceVersion = null;
  try {
    sourceVersion = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version ?? null;
  } catch {}
  const hash = createHash("sha256");
  const jsonFiles = readdirSync(dataDir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort();
  for (const file of jsonFiles) {
    hash.update(file);
    hash.update(readFileSync(join(dataDir, file)));
  }

  const catalog = [];
  for (const file of jsonFiles) {
    const id = file.replace(/\.json$/, "");
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
    } catch {
      continue;
    }
    const completions = parsed?.["openai-completions"];
    if (completions === null || typeof completions !== "object") continue;

    // 显示名：从同目录 providers/<id>.js 的 createProvider({ name: "..." }) 提取。
    // 该 JS 也是生成产物输入的一部分，纳入 sourceSha256。
    let displayName = id;
    const providerFile = join(dirname(dataDir), `${id}.js`);
    if (existsSync(providerFile)) {
      const providerSource = readFileSync(providerFile, "utf8");
      hash.update(`provider:${id}`);
      hash.update(providerSource);
      const match = /name:\s*"([^"]+)"/.exec(providerSource);
      if (match) displayName = match[1];
    }

    /** @type {Record<string, {input: number, cacheRead: number, output: number}>} */
  const models = {};
    let baseUrl = null;
    for (const [modelId, entry] of Object.entries(completions)) {
      if (entry === null || typeof entry !== "object") continue;
      if (typeof modelId !== "string" || modelId === "") continue;
      const cost = entry.cost;
      if (cost === null || typeof cost !== "object") continue;
      const input = toFinite(cost.input);
      const output = toFinite(cost.output);
      if (input === null && output === null) continue;
      const cacheRead = toFinite(cost.cacheRead) ?? 0;
      models[modelId] = {
        input: input ?? 0,
        cacheRead,
        output: output ?? 0
      };
      if (baseUrl === null && typeof entry.baseUrl === "string" && entry.baseUrl !== "") {
        baseUrl = entry.baseUrl;
      }
    }
    if (Object.keys(models).length === 0) continue;
    catalog.push({ id, displayName, baseUrl, models });
  }

  catalog.sort((a, b) => a.id.localeCompare(b.id));
  return { catalog, sourceVersion, sourceSha256: hash.digest("hex") };
}

/** 组装生成文件全文（header 血缘注释 + 目录 JSON）。
 * @param {object} provenance
 * @param {SyncCatalogEntry[]} catalog
 * @returns {string}
 */
export function renderCatalogFile(provenance, catalog) {
  const header = `// AUTO-GENERATED by scripts/sync-providers.js — do not edit by hand.
// 来源：Harness 内置 pi-ai 供应商目录（官方价格，USD / 1M tokens）。
// 数据血缘见 PI_AI_CATALOG_META；Harness 升级后重跑 \`node scripts/sync-providers.js\` 同步。
export const PI_AI_CATALOG_META = Object.freeze(${JSON.stringify(provenance, null, "\t")});
export const PI_AI_CATALOG = `;
  return header + JSON.stringify(catalog, null, "\t") + ";\n";
}

/** 主流程：探测数据源 → 构建 → 写盘（CHECK_MODE 继承环境相关字段）。 */
function main() {
  const source = findSource();
  if (source === null || !existsSync(source.dataDir)) {
    console.error("sync-providers: cannot locate pi-ai data dir; pass --pi-ai-dir <path>");
    process.exit(1);
  }

  const { catalog, sourceVersion, sourceSha256 } = buildCatalogFromData(source.dataDir, source.packageDir);

  // generatedAt / sourceKind 依赖生成环境（何时生成、机器上是否有 Harness 安装），
  // 不应造成跨环境 diff：CHECK_MODE 下从已提交文件继承，完整重跑才写本次真实值。
  let generatedAt = new Date().toISOString();
  let sourceKind = source.sourceKind;
  if (CHECK_MODE) {
    try {
      const existing = readFileSync(OUT, "utf8");
      const atMatch = /"generatedAt":\s*"([^"]+)"/.exec(existing);
      if (atMatch) generatedAt = atMatch[1];
      const kindMatch = /"sourceKind":\s*"([^"]+)"/.exec(existing);
      if (kindMatch) sourceKind = kindMatch[1];
    } catch { /* 首次生成没有旧文件 */ }
  }
  const provenance = {
    source: "@earendil-works/pi-ai dist/providers/data + dist/providers/<id>.js",
    sourceKind,
    sourceVersion,
    sourceSha256,
    generatedAt,
    generator: "scripts/sync-providers.js"
  };

  writeFileSync(OUT, renderCatalogFile(provenance, catalog), "utf8");

  const stats = catalog.map((p) => `${p.id}(${Object.keys(p.models).length})`).join(" ");
  console.log(`sync-providers: wrote ${OUT}`);
  console.log(`pi-ai version: ${sourceVersion ?? "unknown"} (sourceKind: ${sourceKind})`);
  console.log(`source sha256: ${provenance.sourceSha256}`);
  console.log(`providers: ${catalog.length}`);
  console.log(stats);
}

// 直跑入口：被 check-upstream.mjs import 时只暴露构建器，不执行写盘。
const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
