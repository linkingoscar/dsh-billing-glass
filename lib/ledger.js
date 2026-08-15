/**
 * 消费账本（host 端持久化）：每条 assistant 消息一条记录，幂等（sessionId,
 * messageId 主键覆盖），供"逐条消息角标"与"今日/本月/累计"聚合。
 *
 * 存储：append-only JSONL（`$DSH_HOME/storages/billing-glass-ledger.jsonl`），
 * 每行一条记录；新记录只追加，不整文件重写。行数或字节数超过阈值时做一次
 * tmp + rename 压缩。旧版 `billing-glass-ledger.json` 自动迁移。
 *
 * 金额语义：`costUsd` 是聚合基准；`costNative` + `nativeCurrency` 是供应商
 * 原生币种展示金额。`priced=false` 表示该条消息因模型无价格而未计价
 * （fail closed，绝不静默按 0 元计费）。
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  statSync,
  existsSync
} from "node:fs";

const LEDGER_FILE = "billing-glass-ledger.jsonl";
const LEGACY_LEDGER_FILE = "billing-glass-ledger.json";
const WRITE_DEBOUNCE_MS = 1000;
const COMPACT_MAX_BYTES = 4 * 1024 * 1024;
const COMPACT_MAX_LINES = 20_000;

function storagesPath(ctx) {
  const homeFn = typeof ctx?.get === "function" ? ctx.get("dshHomePath") : void 0;
  if (typeof homeFn === "function") return homeFn("storages");
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, "storages");
  return join(homedir(), ".dsh", "storages");
}

function localKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return { day: `${y}-${m}-${d}`, month: `${y}-${m}` };
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeEntry(entry) {
  if (entry === null || typeof entry !== "object") return null;
  if (typeof entry.sessionId !== "string" || typeof entry.messageId !== "string") return null;
  const legacyCostNative = finite(entry.cost) ? entry.cost : 0;
  const nativeCurrency =
    typeof entry.nativeCurrency === "string" && entry.nativeCurrency !== ""
      ? entry.nativeCurrency
      : typeof entry.currency === "string" && entry.currency !== ""
        ? entry.currency
        : "USD";
  const priced = entry.priced !== false;
  return {
    sessionId: entry.sessionId,
    messageId: entry.messageId,
    providerId: entry.providerId ?? null,
    model: entry.model ?? null,
    nativeCurrency,
    time: Number.isFinite(entry.time) ? entry.time : Date.now(),
    costNative: finite(entry.costNative) ? entry.costNative : legacyCostNative,
    costUsd: finite(entry.costUsd) ? entry.costUsd : 0,
    priced,
    unpricedReason: priced ? null : typeof entry.unpricedReason === "string" ? entry.unpricedReason : "pricing_unknown",
    inputTokens: Number.isFinite(entry.inputTokens) ? entry.inputTokens : 0,
    cacheReadTokens: Number.isFinite(entry.cacheReadTokens) ? entry.cacheReadTokens : 0,
    outputTokens: Number.isFinite(entry.outputTokens) ? entry.outputTokens : 0
  };
}

export function createLedger(ctx, options = {}) {
  const records = new Map(); // `${sessionId}\u0000${messageId}` -> record
  const dir = options.storagesDir ?? storagesPath(ctx);
  const path = join(dir, LEDGER_FILE);
  const legacyPath = join(dir, LEGACY_LEDGER_FILE);
  const dirtyKeys = new Set();
  let timer = null;
  let dirty = false;
  let lineCount = 0;

  function setRecord(entry) {
    records.set(`${entry.sessionId}\u0000${entry.messageId}`, entry);
    dirtyKeys.add(`${entry.sessionId}\u0000${entry.messageId}`);
    dirty = true;
  }

  function loadJsonl() {
    if (!existsSync(path)) return false;
    let count = 0;
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line === "") continue;
        count += 1;
        let entry;
        try { entry = normalizeEntry(JSON.parse(line)); } catch { continue; }
        if (entry !== null) records.set(`${entry.sessionId}\u0000${entry.messageId}`, entry);
      }
    } catch { return false; }
    lineCount = count;
    return true;
  }

  function loadLegacy() {
    if (!existsSync(legacyPath)) return false;
    try {
      const parsed = JSON.parse(readFileSync(legacyPath, "utf8"));
      if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.records)) {
        for (const entry of parsed.records) {
          const normalized = normalizeEntry(entry);
          if (normalized !== null) records.set(`${normalized.sessionId}\u0000${normalized.messageId}`, normalized);
        }
        for (const key of records.keys()) dirtyKeys.add(key);
        dirty = true;
        return true;
      }
    } catch { /* 损坏的旧文件从空账本开始 */ }
    return false;
  }

  function appendDirty() {
    if (dirtyKeys.size === 0) {
      dirty = false;
      return true;
    }
    const lines = [];
    for (const key of dirtyKeys) {
      const entry = records.get(key);
      if (entry !== void 0) lines.push(JSON.stringify(entry));
    }
    if (lines.length === 0) {
      dirtyKeys.clear();
      dirty = false;
      return true;
    }
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(path, lines.join("\n") + "\n", "utf8");
      for (const key of dirtyKeys) dirtyKeys.delete(key);
      lineCount += lines.length;
      dirty = dirtyKeys.size > 0;
      return true;
    } catch {
      // 写盘失败：dirty 保持 true，退出钩子与下一次 record/定时器会重试。
      return false;
    }
  }

  function compact() {
    const lines = [...records.values()].map((entry) => JSON.stringify(entry));
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf8");
      renameSync(tmp, path);
      lineCount = lines.length;
      return true;
    } catch {
      return false; // 追加数据已落盘，压缩失败留待下次重试
    }
  }

  function writeNow() {
    if (!appendDirty()) return;
    try {
      const stats = statSync(path);
      if (stats.size > COMPACT_MAX_BYTES || lineCount > COMPACT_MAX_LINES) compact();
    } catch { /* 压缩失败不阻断，数据已追加落盘 */ }
  }

  function scheduleWrite() {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      writeNow();
    }, WRITE_DEBOUNCE_MS);
  }

  /** 幂等记录一条消息费用（同 sessionId+messageId 覆盖，不重复累计）。 */
  function record(entry) {
    const normalized = normalizeEntry(entry);
    if (normalized === null) return;
    setRecord(normalized);
    scheduleWrite();
  }

  /** 某会话的全部消息记录（按时间升序）。 */
  function querySession(sessionId) {
    const prefix = `${sessionId}\u0000`;
    const found = [];
    for (const [key, entry] of records) {
      if (key.startsWith(prefix)) found.push(entry);
    }
    found.sort((a, b) => a.time - b.time);
    return found;
  }

  /** 单条消息费用（供角标查询）。 */
  function queryMessage(sessionId, messageId) {
    return records.get(`${sessionId}\u0000${messageId}`) ?? null;
  }

  /**
   * 今日 / 本月 / 累计聚合（金额按 USD 汇总；调用次数、token 与未计价条数一并统计）。
   * @param now - 聚合基准时间（本地时区）。
   */
  function summary(now = new Date()) {
    const keys = localKey(now);
    const acc = {
      today: { costUsd: 0, calls: 0, unpricedCalls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      month: { costUsd: 0, calls: 0, unpricedCalls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      total: { costUsd: 0, calls: 0, unpricedCalls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
    };
    for (const entry of records.values()) {
      const entryKeys = localKey(new Date(entry.time));
      for (const bucket of [acc.total, entryKeys.month === keys.month ? acc.month : null, entryKeys.day === keys.day ? acc.today : null]) {
        if (bucket === null) continue;
        bucket.costUsd += entry.costUsd;
        bucket.calls += 1;
        if (entry.priced === false) bucket.unpricedCalls += 1;
        bucket.inputTokens += entry.inputTokens;
        bucket.cacheReadTokens += entry.cacheReadTokens;
        bucket.outputTokens += entry.outputTokens;
      }
    }
    return acc;
  }

  if (!loadJsonl()) {
    loadLegacy();
    if (dirty) scheduleWrite();
  }

  // 进程退出兜底 flush（防抖定时器覆盖正常路径；append 失败时 dirty 未清会重试）。
  process.on("exit", writeNow);

  return { record, querySession, queryMessage, summary, flushSync: writeNow };
}
