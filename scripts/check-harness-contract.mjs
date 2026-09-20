import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(process.argv[2] ?? "");
const tag = process.argv[3] ?? "unknown";
if (process.argv[2] === undefined) throw new Error("用法: npm run check:harness -- <deepseek-harness checkout> <tag>");
const ref = tag === "unknown" ? "HEAD" : tag;
execFileSync("git", ["-C", root, "rev-parse", "--verify", `${ref}^{commit}`], { stdio: "ignore" });

/** Search production source at the named ref; tests/docs must not satisfy a removed API.
 * @param {string} pattern
 * @param {string} path
 */
function has(pattern, path) {
  try {
    execFileSync("git", ["-C", root, "grep", "-F", "-l", "-e", pattern, ref, "--", path], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const persistence = "packages/session/session-persistence/src/index.ts";
const handles = has("abstract open(", persistence) && has("abstract stat(", persistence);
const version = /(?:dsh-v)?(\d+)\.(\d+)\.(\d+)/.exec(tag);
const requiresAuth = version !== null && (
  Number(version[1]) > 0 || Number(version[2]) > 1 || Number(version[3]) >= 2
);
const checks = [
  ["assistant/message", "packages/core/session/src/known-event-types.ts"],
  ["request/header", "packages/core/session/src/known-event-types.ts"],
  ["shell.overlay", ":(glob)packages/client/**/src/**"],
  ["conversation.chat.assistant-actions", ":(glob)packages/client/**/src/**"],
  ["settings.section", ":(glob)packages/client/**/src/**"],
  ...(handles ? [
    ["abstract open(", persistence],
    ["abstract stat(", persistence],
    ["read(", "packages/session/session-persistence/src/handle.ts"],
    ["close()", "packages/session/session-persistence/src/handle.ts"]
  ] : [
    ["supportsRawArtifacts", persistence],
    ["readRaw(", persistence],
    ["readStoredRevision(", ":(glob)packages/session/session-persistence-jsonl/src/**"]
  ]),
  ...(requiresAuth ? [["requestRejection(", ":(glob)packages/client/connection/src/**"]] : [])
];
const missing = checks.filter(([pattern, path]) => !has(pattern, path)).map(([pattern, path]) => `${pattern} (${path})`);
if (missing.length > 0) throw new Error(`${tag} 缺少插件依赖契约: ${missing.join(", ")}`);
console.log(`${tag}: billing source anchors present (${checks.length}, ${handles ? "SessionHandle; checking read behavior next" : "legacy raw log"})`);
// Check the actual list shape; slot names alone missed the removal of current.
const listPath = execFileSync("git", ["-C", root, "grep", "-l", "export interface SessionListState", ref, "--", ":(glob)packages/**/src/**"], { encoding: "utf8" }).trim().split("\n")[0];
const listSource = execFileSync("git", ["-C", root, "show", listPath], { encoding: "utf8" });
const listShape = /export interface SessionListState \{([\s\S]*?)\n\}/.exec(listSource)?.[1] ?? "";
if (!/\bcurrent[?:]/.test(listShape) && !(listShape.includes("byId:") && listSource.includes("readonly retainedBy:") && has("retainedBy.mainView", ":(glob)packages/client/**/src/**"))) {
  throw new Error(`${tag}: unrecognized main-session selection contract`);
}
execFileSync(process.execPath, ["--test", fileURLToPath(new URL("../tests/verify-multisession-client.mjs", import.meta.url))], { stdio: "inherit" });
if (handles) {
  const handlePath = "packages/session/session-persistence/src/handle.ts";
  const source = execFileSync("git", ["-C", root, "show", `${ref}:${handlePath}`], { encoding: "utf8" });
  const result = /\bread\([^\n]+\): Promise<([^\n]+)>/.exec(source)?.[1];
  const format = result === "readonly SessionEvent[]" ? "array"
    : result === "SessionHandleReadResult" && source.includes("readonly events: readonly SessionEvent[]") ? "slice" : null;
  if (format === null) throw new Error(`${tag}: unrecognized SessionHandle.read result: ${result}`);
  execFileSync(process.execPath, ["--test", fileURLToPath(new URL("../tests/verify-session-handles.mjs", import.meta.url))], {
    stdio: "inherit", env: { ...process.env, DSH_HARNESS_READ_FORMAT: format }
  });
}
