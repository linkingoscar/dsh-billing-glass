/**
 * 消费账本（host 端持久化）：每条 assistant 消息一条记录，幂等（sessionId,
 * messageId 主键覆盖），供"逐条消息角标"与"今日/本月/累计"聚合。
 *
 * 落盘：`$DSH_HOME/storages/billing-glass-ledger.json`，1s 防抖 + 临时文件
 * 原子替换；进程退出时同步补一次 flush。金额存双币种（cost 为主币种、
 * costUsd 为美元），聚合统一用 USD，展示端按当前供应商币种换算。
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";

const LEDGER_FILE = "billing-glass-ledger.json";
const WRITE_DEBOUNCE_MS = 1000;

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

export function createLedger(ctx, options = {}) {
  const records = new Map(); // `${sessionId}\u0000${messageId}` -> record
  const dir = options.storagesDir ?? storagesPath(ctx);
  const path = join(dir, LEDGER_FILE);
  let timer = null;
  let dirty = false;

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed.records)) {
        for (const entry of parsed.records) {
          if (entry !== null && typeof entry === "object" && typeof entry.sessionId === "string" && typeof entry.messageId === "string") {
            records.set(`${entry.sessionId}\u0000${entry.messageId}`, entry);
          }
        }
      }
    } catch { /* 首次运行或损坏文件从空账本开始 */ }
  }

  function writeNow() {
    if (!dirty) return;
    dirty = false;
    try {
      mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({ version: 1, records: [...records.values()] });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, body, "utf8");
      renameSync(tmp, path);
    } catch { /* 落盘失败不阻断（下次写重试） */ }
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
    if (entry === null || typeof entry !== "object") return;
    if (typeof entry.sessionId !== "string" || typeof entry.messageId !== "string") return;
    records.set(`${entry.sessionId}\u0000${entry.messageId}`, {
      sessionId: entry.sessionId,
      messageId: entry.messageId,
      providerId: entry.providerId ?? null,
      model: entry.model ?? null,
      currency: typeof entry.currency === "string" && entry.currency !== "" ? entry.currency : "USD",
      time: Number.isFinite(entry.time) ? entry.time : Date.now(),
      cost: Number.isFinite(entry.cost) ? entry.cost : 0,
      costUsd: Number.isFinite(entry.costUsd) ? entry.costUsd : 0,
      inputTokens: Number.isFinite(entry.inputTokens) ? entry.inputTokens : 0,
      cacheReadTokens: Number.isFinite(entry.cacheReadTokens) ? entry.cacheReadTokens : 0,
      outputTokens: Number.isFinite(entry.outputTokens) ? entry.outputTokens : 0
    });
    dirty = true;
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
   * 今日 / 本月 / 累计聚合（金额按 USD 汇总，调用次数与 token 一并统计）。
   * @param now - 聚合基准时间（本地时区）。
   */
  function summary(now = new Date()) {
    const keys = localKey(now);
    const acc = {
      today: { costUsd: 0, calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      month: { costUsd: 0, calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
      total: { costUsd: 0, calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
    };
    for (const entry of records.values()) {
      const entryKeys = localKey(new Date(entry.time));
      for (const bucket of [acc.total, entryKeys.month === keys.month ? acc.month : null, entryKeys.day === keys.day ? acc.today : null]) {
        if (bucket === null) continue;
        bucket.costUsd += entry.costUsd;
        bucket.calls += 1;
        bucket.inputTokens += entry.inputTokens;
        bucket.cacheReadTokens += entry.cacheReadTokens;
        bucket.outputTokens += entry.outputTokens;
      }
    }
    return acc;
  }

  load();
  // 进程退出兜底 flush（防抖定时器覆盖正常路径）。
  process.on("exit", writeNow);

  return { record, querySession, queryMessage, summary, flushSync: writeNow };
}
