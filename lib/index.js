/**
 * dsh-billing-glass — host half.
 *
 * 聚合路由：GET /api/billing-glass/state?sessionId=<id>
 *
 *   {
 *     ok: true,
 *     sessionId,
 *     activeProvider: "deepseek",          // 当前会话最近请求的供应商
 *     activeModel: "deepseek-v4-pro",      // 当前会话最近请求的模型
 *     providers: [
 *       {
 *         id, displayName, currency,
 *         balance: { total, granted, toppedUp, available, currency } | null,
 *         balanceError: string | null,
 *         session: { cost, costUsd, calls, inputTokens, cacheReadTokens,
 *                    outputTokens, breakdown: [...] } | null,
 *         today: { consumed, source: "estimate" } | null
 *       }, ...
 *     ]
 *   }
 *
 * 会话费用 = 持久化日志全量回放（包含安装前的历史）优先，进行中消息用
 * session/event 实时账本兜底；每条 assistant/message 按其完成时刻的官方价格
 * 政策（含峰谷）计价，按 request/header 的 provider 归属到对应供应商。
 */
import { PROVIDERS, matchProvider } from "./providers/registry.js";
import { createLedger } from "./ledger.js";

const name = "dsh-billing-glass";
const inject = ["credentials", "webServer"];

const ROUTE_PATH = "/api/billing-glass/state";
const BALANCE_TTL_MS = 60 * 1000;
const REPLAY_MIN_INTERVAL_MS = 2000;

/** 从 header/config 或 message.source 里提取 OpenAI 兼容 baseURL（pi-ai 网关）。 */
function extractBaseUrl(source) {
  if (source === null || typeof source !== "object") return void 0;
  for (const key of ["baseURL", "baseUrl", "base_url"]) {
    if (typeof source[key] === "string" && source[key] !== "") return source[key];
  }
  return void 0;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function roundCost(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** 空的会话费用记录（扁平合计 + 分桶明细）。 */
function emptyCostRecord() {
  return {
    calls: 0,
    cost: 0,
    costUsd: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    buckets: {
      input: { tokens: 0, cost: 0 },
      cacheRead: { tokens: 0, cost: 0 },
      output: { tokens: 0, cost: 0 }
    }
  };
}

/** 把一条 assistant/message 事件计价并入费用记录，返回该条消息的费用样本。 */
function priceEventInto(record, event, provider) {
  const usage = event.data?.usage;
  if (usage === void 0 || usage === null) return null;
  if (typeof usage.outputTokens !== "number" && typeof usage.inputTokens !== "number") return null;
  const model = typeof event.data?.message?.source?.model === "string"
    ? event.data.message.source.model
    : provider?.defaultModel ?? "unknown";
  const unit = provider.priceAt(model, event.time ?? Date.now());
  const sample = provider.costOf(usage, unit);
  record.calls += 1;
  record.cost += sample.cost;
  record.costUsd += sample.costUsd;
  record.inputTokens += sample.inputTokens;
  record.cacheReadTokens += sample.cacheReadTokens;
  record.outputTokens += sample.outputTokens;
  record.buckets.input.tokens += sample.inputTokens;
  record.buckets.input.cost += (sample.inputTokens * unit.cny.input) / 1e6;
  record.buckets.cacheRead.tokens += sample.cacheReadTokens;
  record.buckets.cacheRead.cost += (sample.cacheReadTokens * unit.cny.cacheRead) / 1e6;
  record.buckets.output.tokens += sample.outputTokens;
  record.buckets.output.cost += (sample.outputTokens * unit.cny.output) / 1e6;
  return { ...sample, model };
}

/** 每桶 { label, tokens, rate, subtotal }，rate 为有效加权价（¥/M）。 */
function breakdownOf(record) {
  const parts = [
    { label: "输入(未命中)", key: "input" },
    { label: "缓存命中", key: "cacheRead" },
    { label: "输出", key: "output" }
  ];
  return parts.map(({ label, key }) => {
    const bucket = record.buckets[key];
    const tokens = bucket.tokens;
    const subtotal = bucket.cost;
    const rate = tokens > 0 ? roundCost((subtotal / tokens) * 1e6) : 0;
    return { label, tokens, rate, subtotal: roundCost(subtotal) };
  });
}

/** 日志回放缓存：sessionId -> { revision, at, byProvider }。 */
const logCostCache = new Map();

/** 消费账本（apply 时创建；回放与实时事件都往里记账）。 */
let ledger = null;

/** 回放整段持久化日志，按 provider 分账。 */
async function replaySessionCost(ctx, sessionId) {
  const persistence = ctx.get("sessionPersistence");
  if (
    persistence === void 0 ||
    typeof persistence.readRaw !== "function" ||
    typeof persistence.readStoredRevision !== "function"
  ) {
    return null;
  }
  let revision;
  try {
    revision = await persistence.readStoredRevision(sessionId);
  } catch (error) {
    ctx.logger.warn("dsh-billing-glass: failed to read session log revision");
    ctx.logger.warn(error);
    return null;
  }
  if (revision === void 0) return null;
  const cached = logCostCache.get(sessionId);
  if (cached !== void 0) {
    if (cached.revision === revision) return cached;
    if (Date.now() - cached.at < REPLAY_MIN_INTERVAL_MS) return cached;
  }
  try {
    const raw = await persistence.readRaw(sessionId);
    if (raw === void 0 || raw === null || typeof raw.content !== "string") return null;
    const byProvider = new Map();
    const ensure = (provider) => {
      let record = byProvider.get(provider.id);
      if (record === void 0) {
        record = emptyCostRecord();
        byProvider.set(provider.id, record);
      }
      return record;
    };
    let lastHeader = null;
    for (const line of raw.content.split("\n")) {
      if (line === "") continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event === null || typeof event !== "object") continue;
      if (event.type === "request/header") {
        const header = event.data?.header?.config;
        if (header !== void 0 && header !== null) lastHeader = header;
        continue;
      }
      if (event.type !== "assistant/message") continue;
      const source = event.data?.message?.source;
      const headerProvider = lastHeader?.provider ?? source?.provider;
      const baseUrl = extractBaseUrl(lastHeader) ?? extractBaseUrl(source);
      const provider = matchProvider(headerProvider, baseUrl);
      if (provider === null) continue;
      try {
        const sample = priceEventInto(ensure(provider), event, provider);
        if (sample !== null && ledger !== null && typeof event.data?.message?.id === "string") {
          ledger.record({
            sessionId,
            messageId: event.data.message.id,
            providerId: provider.id,
            model: sample.model,
            currency: provider.currency,
            time: event.time ?? Date.now(),
            cost: sample.cost,
            costUsd: sample.costUsd,
            inputTokens: sample.inputTokens,
            cacheReadTokens: sample.cacheReadTokens,
            outputTokens: sample.outputTokens
          });
        }
      } catch { /* 单条坏消息不阻断整段回放 */ }
    }
    const result = { revision, at: Date.now(), byProvider };
    logCostCache.set(sessionId, result);
    return result;
  } catch (error) {
    ctx.logger.warn("dsh-billing-glass: failed to replay session log for costing");
    ctx.logger.warn(error);
    return null;
  }
}

function apply(ctx) {
  ledger = createLedger(ctx);

  // ---- 实时账本与 header 跟踪 ------------------------------------------
  const liveBySession = new Map(); // sessionId -> { byProvider, lastProvider, lastModel }

  ctx.on("session/event", (session, event) => {
    try {
      if (event?.type === "request/header") {
        const header = event.data?.header?.config;
        if (header !== void 0 && header !== null) {
          const provider = matchProvider(header.provider, extractBaseUrl(header));
          let entry = liveBySession.get(session.id);
          if (entry === void 0) {
            entry = { byProvider: new Map(), lastProvider: null, lastModel: null, unrecognized: null };
            liveBySession.set(session.id, entry);
          }
          if (provider !== null) {
            entry.lastProvider = provider.id;
            entry.unrecognized = null;
          } else {
            // Harness 官方目录未列举的供应商：记录下来，前端引导用户提供计价方案。
            entry.unrecognized = {
              provider: typeof header.provider === "string" ? header.provider : null,
              baseUrl: extractBaseUrl(header) ?? null,
              model: typeof header.model === "string" ? header.model : null
            };
          }
          if (typeof header.model === "string" && header.model !== "") entry.lastModel = header.model;
        }
        return;
      }
      if (event?.type !== "assistant/message") return;
      const source = event.data?.message?.source;
      const provider = matchProvider(source?.provider, extractBaseUrl(source));
      if (provider === null) return;
      let entry = liveBySession.get(session.id);
      if (entry === void 0) {
        entry = { byProvider: new Map(), lastProvider: provider.id, lastModel: null };
        liveBySession.set(session.id, entry);
      }
      let record = entry.byProvider.get(provider.id);
      if (record === void 0) {
        record = emptyCostRecord();
        entry.byProvider.set(provider.id, record);
      }
      const sample = priceEventInto(record, event, provider);
      const messageId = event.data?.message?.id;
      if (sample !== null && typeof messageId === "string" && messageId !== "") {
        ledger.record({
          sessionId: session.id,
          messageId,
          providerId: provider.id,
          model: sample.model,
          currency: provider.currency,
          time: event.time ?? Date.now(),
          cost: sample.cost,
          costUsd: sample.costUsd,
          inputTokens: sample.inputTokens,
          cacheReadTokens: sample.cacheReadTokens,
          outputTokens: sample.outputTokens
        });
      }
      entry.lastProvider = provider.id;
    } catch (error) {
      ctx.logger.warn("dsh-billing-glass: failed to price a session event");
      ctx.logger.warn(error);
    }
  });

  // ---- 余额缓存（TTL 60s，失败不缓存，下一次轮询自愈）------------------
  const balanceCache = new Map(); // providerId -> { at, data, error }

  async function balanceOf(provider) {
    const hit = balanceCache.get(provider.id);
    if (hit !== void 0 && Date.now() - hit.at < BALANCE_TTL_MS) return hit;
    let data = null;
    let error = null;
    try {
      data = await provider.fetchBalance(ctx, {});
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const entry = { at: Date.now(), data, error };
    if (error === null) balanceCache.set(provider.id, entry);
    return entry;
  }

  /**
   * Harness 后台配置的现行供应商/模型（设置 → 模型 的默认选择，
   * 即 `agent-default-model` 设置段，服务名 agentDefaultModel）。
   */
  function readConfigured() {
    try {
      const service = ctx.get("agentDefaultModel");
      const selection = typeof service?.currentSelection === "function" ? service.currentSelection() : null;
      if (selection !== null && selection !== void 0) {
        return {
          providerId: matchProvider(selection.provider)?.id ?? null,
          model: typeof selection.model === "string" ? selection.model : null
        };
      }
    } catch (err) {
      ctx.logger.warn("dsh-billing-glass: failed to read agentDefaultModel selection");
      ctx.logger.warn(err);
    }
    return { providerId: null, model: null };
  }

  // ---- 聚合路由 --------------------------------------------------------
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          const sessionId = new URL(req.url ?? "/", "http://x").searchParams.get("sessionId") ?? "";
          const live = sessionId === "" ? void 0 : liveBySession.get(sessionId);
          const replay = sessionId === "" ? null : await replaySessionCost(ctx, sessionId);
          const { providerId: configuredProviderId, model: configuredModel } = readConfigured();

          const providerRows = [];
          for (const provider of PROVIDERS) {
            const balanceEntry = await balanceOf(provider);

            // 该供应商是否已配置 Key（探测凭证缝，随余额缓存 TTL）。
            let keyConfigured = null;
            if (typeof provider.keyRef === "string" && typeof ctx.credentials?.resolve === "function") {
              try {
                keyConfigured = (await ctx.credentials.resolve(provider.keyRef)) !== void 0;
              } catch {
                keyConfigured = null;
              }
            }

            // 当前时刻的计价档（供"套餐"行展示：峰时/谷时/标准）。
            let rateMode = null;
            try {
              const unit = provider.priceAt(provider.defaultModel, Date.now());
              rateMode = unit.mode ?? null;
            } catch {
              rateMode = null;
            }

            // 会话费用：日志回放优先，实时账本兜底。
            let session = null;
            if (replay !== null) {
              const record = replay.byProvider.get(provider.id);
              if (record !== void 0) session = { ...record, breakdown: breakdownOf(record), source: "log" };
            }
            if (session === null && live !== void 0) {
              const record = live.byProvider.get(provider.id);
              if (record !== void 0) session = { ...record, breakdown: breakdownOf(record), source: "live" };
            }
            if (session !== null) {
              session.cost = roundCost(session.cost);
              session.costUsd = roundCost(session.costUsd);
            }

            // 今日消费（官方平台数据优先，余额差估算兜底）。
            let today = null;
            if (balanceEntry.data !== null && typeof provider.todayConsumed === "function") {
              try {
                const result = await provider.todayConsumed(ctx, {}, balanceEntry.data);
                if (result !== null && typeof result === "object" && Number.isFinite(result.consumed)) {
                  today = { consumed: result.consumed, source: result.source ?? "estimate" };
                } else if (typeof result === "number" && Number.isFinite(result)) {
                  today = { consumed: result, source: "estimate" }; // 兼容旧契约
                }
              } catch (err) {
                ctx.logger.warn(`dsh-billing-glass: today-consumed failed for ${provider.id}`);
                ctx.logger.warn(err);
              }
            }

            providerRows.push({
              id: provider.id,
              displayName: provider.displayName,
              currency: balanceEntry.data?.currency ?? provider.currency,
              isConfiguredProvider: provider.id === configuredProviderId,
              keyConfigured,
              refreshSupported: typeof provider.refreshPricing === "function",
              plan: provider.plan ?? null,
              rateMode,
              balance: balanceEntry.data === null ? null : {
                total: balanceEntry.data.total,
                granted: balanceEntry.data.granted,
                toppedUp: balanceEntry.data.toppedUp,
                available: balanceEntry.data.available
              },
              balanceError: balanceEntry.error,
              session,
              today
            });
          }

          sendJson(res, 200, {
            ok: true,
            sessionId,
            activeProvider: live?.lastProvider ?? null,
            activeModel: live?.lastModel ?? null,
            configuredProvider: configuredProviderId,
            configuredModel: configuredModel,
            unrecognized: live?.unrecognized ?? null,
            summary: ledger.summary(),
            providers: providerRows
          });
        } catch (error) {
          ctx.logger.warn("dsh-billing-glass: state route failed");
          ctx.logger.warn(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-billing-glass: state route"
  );

  // ---- 会话消息账本路由（逐条消息角标数据源）----------------------------
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/billing-glass/ledger",
      handler: async (req, res) => {
        try {
          const sessionId = new URL(req.url ?? "/", "http://x").searchParams.get("sessionId") ?? "";
          if (sessionId === "") {
            sendJson(res, 200, { ok: true, messages: [] });
            return;
          }
          const messages = ledger.querySession(sessionId).map((entry) => ({
            messageId: entry.messageId,
            providerId: entry.providerId,
            model: entry.model,
            currency: entry.currency,
            time: entry.time,
            cost: entry.cost,
            costUsd: entry.costUsd,
            inputTokens: entry.inputTokens,
            cacheReadTokens: entry.cacheReadTokens,
            outputTokens: entry.outputTokens
          }));
          sendJson(res, 200, { ok: true, sessionId, messages });
        } catch (error) {
          ctx.logger.warn("dsh-billing-glass: ledger route failed");
          ctx.logger.warn(error);
          sendJson(res, 500, { ok: false, error: "internal", message: "internal error" });
        }
      }
    }),
    "dsh-billing-glass: ledger route"
  );

  // ---- 定价校验路由（只刷新指定的当前供应商）----------------------------
  const REFRESH_MIN_INTERVAL_MS = 60 * 1000;
  const lastRefreshAt = new Map(); // providerId -> timestamp（防抖）

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/billing-glass/refresh-pricing",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://x");
          let providerId = url.searchParams.get("providerId");
          const live = liveBySession.get(url.searchParams.get("sessionId") ?? "") ?? null;
          if (providerId === null || providerId === "") {
            providerId = live?.lastProvider ?? readConfigured().providerId ?? PROVIDERS[0]?.id;
          }
          const provider = PROVIDERS.find((p) => p.id === providerId) ?? null;
          if (provider === null) {
            sendJson(res, 404, { ok: false, error: "unknown-provider", message: `未知供应商: ${providerId}` });
            return;
          }
          const last = lastRefreshAt.get(provider.id) ?? 0;
          if (Date.now() - last < REFRESH_MIN_INTERVAL_MS) {
            sendJson(res, 200, { ok: true, providerId: provider.id, status: "busy", message: "刚刚校验过，稍后再试" });
            return;
          }
          if (typeof provider.refreshPricing !== "function") {
            lastRefreshAt.set(provider.id, Date.now());
            sendJson(res, 200, {
              ok: true,
              providerId: provider.id,
              status: "unsupported",
              message: `${provider.displayName} 价格随 Harness 官方目录同步（scripts/sync-providers.js 生成）；如需立即核对最新价格，请在对话中告知助手。`
            });
            return;
          }
          lastRefreshAt.set(provider.id, Date.now());
          const report = await provider.refreshPricing(ctx);
          sendJson(res, 200, { ok: true, providerId: provider.id, ...report });
        } catch (error) {
          ctx.logger.warn("dsh-billing-glass: refresh-pricing failed");
          ctx.logger.warn(error);
          sendJson(res, 502, {
            ok: false,
            status: "unavailable",
            message: error instanceof Error ? error.message : String(error),
            details: ["拉取官方定价源失败，请稍后重试；若持续失败请在对话中告知助手"]
          });
        }
      }
    }),
    "dsh-billing-glass: refresh pricing route"
  );
}

export { name, inject, apply };
