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
 *         session: { costNative, nativeCurrency, costUsd, calls, unpricedCalls,
 *                    inputTokens, cacheReadTokens, outputTokens,
 *                    breakdown: [...] } | null,
 *         today: { consumed, source: "estimate" } | null
 *       }, ...
 *     ]
 *   }
 *
 * 会话费用 = 持久化日志全量回放（包含安装前的历史）优先，进行中消息用
 * session/event 实时账本兜底；每条 assistant/message 按其完成时刻的官方价格
 * 政策（含峰谷）计价，按 request/header 的 provider 归属到对应供应商。
 * 金额语义：costUsd 是聚合基准，costNative + nativeCurrency 是供应商原生金额。
 * 模型无价格时该调用标记 unpricedCalls（fail closed，绝不静默按 0 计费）。
 */
import { PROVIDERS, matchProvider } from "./providers/registry.js";
import { createLedger } from "./ledger.js";
import { impliedFxRate } from "./providers/deepseek-pricing.js";
import {
  emptyCostRecord,
  resolveMessageContext,
  priceEventInto,
  upsertMessageSample,
  mergeCostRecords,
  breakdownOf,
  extractBaseUrl,
  roundCost
} from "./session-costing.js";

// 测试兼容面：纯管道已拆至 session-costing.js，这里保持既有导出。
export { emptyCostRecord, resolveMessageContext, priceEventInto, upsertMessageSample };

const name = "dsh-billing-glass";
const inject = ["credentials", "webServer", "connection"];

const ROUTE_PATH = "/api/billing-glass/state";
const BALANCE_TTL_MS = 60 * 1000;
const DEEPSEEK_BALANCE_TTL_MS = 10 * 1000;
const TODAY_TTL_MS = 5 * 60 * 1000;
const REPLAY_MIN_INTERVAL_MS = 2000;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

/**
 * @param {any} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/** Reuse the host's launch-token/Host/Origin policy when the alpha API exposes it.
 * @param {any} ctx
 * @param {any} req
 * @param {any} res
 */
function rejectUnauthorizedRequest(ctx, req, res) {
  let connection;
  try {
    connection = ctx.connection ?? ctx.get?.("connection");
  } catch {
    connection = undefined;
  }
  if (typeof connection?.requestRejection !== "function") return false;
  const status = connection.requestRejection(req);
  if (status === undefined) return false;
  sendJson(res, status, { ok: false, error: status === 401 ? "unauthorized" : "forbidden" });
  return true;
}

/**
 * 展示层换算率（CNY/USD）：env 显式覆盖 > 官方政策隐含平价 > 历史常数兜底。
 * 仅用于混合币种聚合展示；单币种账本走 ledger.summary 的原生合计，不经此换算。
 * @returns {number}
 */
function fxCnyPerUsd() {
  const raw = process.env.DSH_BILLING_FX_CNY_PER_USD;
  if (typeof raw === "string" && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return impliedFxRate(Date.now()) ?? 7.2;
}

/** @import { ProviderContract, CostSample } from "./types.js" */

/** @param {import("./types.js").HostContext} ctx */
function apply(ctx) {
  const ledger = createLedger(ctx);
  ctx.effect(() => () => { ledger.dispose(); }, "dsh-billing-glass: ledger lifecycle");

  // 回放缓存与账本都收在 apply 生命周期内：hot reload / 多 profile 不会串账。
  /** @type {Map<string, {revision: unknown, at: number, byProvider: Map<string, import("./types.js").CostRecord>}>} */
  const logCostCache = new Map();

  /**
   * @param {string} sessionId
   * @param {unknown} messageId
   * @param {ProviderContract} provider
   * @param {CostSample|null} sample
   * @param {number} time
   */
  function recordSample(sessionId, messageId, provider, sample, time) {
    if (sample === null || typeof messageId !== "string" || messageId === "") return;
    const priced = sample.priced !== false;
    ledger.record({
      sessionId,
      messageId,
      providerId: provider.id,
      model: sample.model,
      nativeCurrency: sample.nativeCurrency ?? provider.currency ?? "USD",
      time,
      costNative: sample.costNative,
      costUsd: sample.costUsd,
      priced,
      unpricedReason: priced ? null : sample.unpricedReason ?? null,
      inputTokens: sample.inputTokens,
      cacheReadTokens: sample.cacheReadTokens,
      outputTokens: sample.outputTokens
    });
  }

  /**
   * 全量回放某会话的持久化日志并按供应商聚合费用（带 revision 缓存与节流）。
   * @param {string} sessionId
   * @returns {Promise<{revision: unknown, at: number, byProvider: Map<string, import("./types.js").CostRecord>}|null>}
   */
  async function replaySessionCost(sessionId) {
    const persistence = ctx.get("sessionPersistence");
    if (
      persistence === void 0 ||
      typeof persistence.readRaw !== "function" ||
      typeof persistence.readStoredRevision !== "function"
    ) {
      return null;
    }
    // 能力位守卫（上游契约）：不支持逐会话原始工件的 backend（如 SQLite）
    // readRaw 会直接 reject；这里显式降级为 live-only，并留下可查的日志。
    if (persistence.supportsRawArtifacts === false) {
      const cached = logCostCache.get(sessionId);
      if (cached !== void 0) return cached;
      ctx.logger.warn("dsh-billing-glass: session persistence backend has no raw artifacts; session cost falls back to live-only");
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
      /** @type {Map<string, import("./types.js").CostRecord>} */
      const byProvider = new Map();
      /** @param {ProviderContract} provider */
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
        const context = resolveMessageContext(event, lastHeader);
        if (context.provider === null) continue;
        try {
          const record = ensure(context.provider);
          const sample = priceEventInto(record, event, context.provider, context);
          const messageId = event.data?.message?.id;
          if (sample !== null) upsertMessageSample(record, messageId, sample);
          recordSample(sessionId, messageId, context.provider, sample, event.time ?? Date.now());
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

  // ---- 实时账本与 header 跟踪 ------------------------------------------
  /** @type {Map<string, {byProvider: Map<string, import("./types.js").CostRecord>, lastProvider: string|null, lastModel: string|null, lastHeader: {provider?: unknown, model?: unknown, baseURL?: unknown}|null, unrecognized: {provider: string|null, baseUrl: string|null, model: string|null}|null}>} */
  const liveBySession = new Map(); // sessionId -> { byProvider, lastProvider, lastModel, lastHeader }

  /**
   * @param {unknown} session
   * @param {import("./types.js").SessionEventLike} event
   */
  ctx.on("session/event", (session, event) => {
    const sessionRecord = /** @type {{id: string}} */ (session);
    try {
      if (event?.type === "request/header") {
        const header = event.data?.header?.config;
        if (header !== void 0 && header !== null) {
          const provider = matchProvider(header.provider, extractBaseUrl(header));
          let entry = liveBySession.get(sessionRecord.id);
          if (entry === void 0) {
            entry = { byProvider: new Map(), lastProvider: null, lastModel: null, lastHeader: null, unrecognized: null };
            liveBySession.set(sessionRecord.id, entry);
          }
          entry.lastHeader = header;
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
      let entry = liveBySession.get(sessionRecord.id);
      if (entry === void 0) {
        entry = { byProvider: new Map(), lastProvider: null, lastModel: null, lastHeader: null, unrecognized: null };
        liveBySession.set(sessionRecord.id, entry);
      }
      const context = resolveMessageContext(event, entry.lastHeader);
      if (context.provider === null) return;
      let record = entry.byProvider.get(context.provider.id);
      if (record === void 0) {
        record = emptyCostRecord();
        entry.byProvider.set(context.provider.id, record);
      }
      const sample = priceEventInto(record, event, context.provider, context);
      const messageId = event.data?.message?.id;
      if (sample !== null) upsertMessageSample(record, messageId, sample);
      recordSample(sessionRecord.id, messageId, context.provider, sample, event.time ?? Date.now());
      entry.lastProvider = context.provider.id;
    } catch (error) {
      ctx.logger.warn("dsh-billing-glass: failed to price a session event");
      ctx.logger.warn(error);
    }
  });

  // ---- 余额缓存（DeepSeek TTL 10s，其它 60s；失败不缓存，force 可绕过）--
  /** @type {Map<string, {at: number, data: any, error: string|null}>} */
  const balanceCache = new Map(); // providerId -> { at, data, error }
  /** @type {Map<string, Promise<{at: number, data: any, error: string|null}>>} */
  const balanceInflight = new Map(); // providerId -> Promise<entry>（single-flight）

  /**
   * @param {ProviderContract} provider
   * @param {boolean=} force
   * @returns {Promise<{at: number, data: any, error: string|null}>}
   */
  async function balanceOf(provider, force = false) {
    const hit = balanceCache.get(provider.id);
    const ttl = provider.id === "deepseek" ? DEEPSEEK_BALANCE_TTL_MS : BALANCE_TTL_MS;
    if (!force && hit !== void 0 && Date.now() - hit.at < ttl) return hit;
    const inflight = balanceInflight.get(provider.id);
    if (inflight !== void 0) return inflight;
    const promise = (async () => {
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
    })();
    balanceInflight.set(provider.id, promise);
    try {
      return await promise;
    } finally {
      if (balanceInflight.get(provider.id) === promise) balanceInflight.delete(provider.id);
    }
  }

  // ---- 今日消费缓存（官方平台内部接口，5 分钟 TTL + single-flight）-------
  /** @type {Map<string, {at: number, value: {consumed: number, source: string}|null}>} */
  const todayCache = new Map(); // providerId -> { at, value }
  /** @type {Map<string, Promise<{consumed: number, source: string}|null>>} */
  const todayInflight = new Map(); // providerId -> Promise<value|null>

  /**
   * @param {string} timezone
   * @returns {string}
   */
  function dateKeyIn(timezone) {
    if (timezone === "local") {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    } catch {
      return dateKeyIn("local");
    }
  }

  /**
   * @param {ProviderContract} provider
   * @param {any} balanceData
   * @param {string=} timezone
   * @returns {Promise<{consumed: number, source: string}|null>}
   */
  async function todayOf(provider, balanceData, timezone = "local") {
    if (balanceData === null || typeof provider.todayConsumed !== "function") return null;
    const accountingTimezone = provider.accountingTimezone ?? timezone;
    const dateKey = dateKeyIn(accountingTimezone);
    const cacheKey = `${provider.id}:${dateKey}`;
    const now = Date.now();
    const hit = todayCache.get(cacheKey);
    if (hit !== void 0 && now - hit.at < TODAY_TTL_MS) return hit.value;
    const inflight = todayInflight.get(cacheKey);
    if (inflight !== void 0) return inflight;
    const promise = (async () => {
      try {
        const todayConsumed = /** @type {NonNullable<ProviderContract["todayConsumed"]>} */ (provider.todayConsumed);
        const result = await todayConsumed(ctx, { timezone: accountingTimezone }, balanceData);
        if (result !== null && typeof result === "object" && Number.isFinite(result.consumed)) {
          return { consumed: result.consumed, source: result.source ?? "official" };
        }
        if (typeof result === "number" && Number.isFinite(result)) {
          return { consumed: result, source: "official" };
        }
        return null;
      } catch (err) {
        ctx.logger.warn(`dsh-billing-glass: today-consumed failed for ${provider.id}`);
        ctx.logger.warn(err);
        return null;
      }
    })();
    todayInflight.set(cacheKey, promise);
    try {
      const value = await promise;
      todayCache.set(cacheKey, { at: Date.now(), value });
      return value;
    } finally {
      if (todayInflight.get(cacheKey) === promise) todayInflight.delete(cacheKey);
    }
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
          providerId: matchProvider(selection.provider, undefined)?.id ?? null,
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
      handler: async (/** @type {{url?: string, method?: string}} */ req, /** @type {any} */ res) => {
        if (rejectUnauthorizedRequest(ctx, req, res)) return;
        try {
          const url = new URL(req.url ?? "/", "http://x");
          const sessionId = url.searchParams.get("sessionId") ?? "";
          const timezone = url.searchParams.get("tz") ?? "local";
          const live = sessionId === "" ? void 0 : liveBySession.get(sessionId);
          const replay = sessionId === "" ? null : await replaySessionCost(sessionId);
          const { providerId: configuredProviderId, model: configuredModel } = readConfigured();

          const providerRows = await Promise.all(PROVIDERS.map(async (provider) => {
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
              const unit = provider.priceAt(/** @type {string} */ (provider.defaultModel), Date.now());
              rateMode = unit?.mode ?? null;
            } catch {
              rateMode = null;
            }

            // 会话费用：replay + live 按 messageId 去重后 union（避免回放节流窗口少算新消息）。
            const replayRecord = replay?.byProvider.get(provider.id);
            const liveRecord = live?.byProvider.get(provider.id);
            let session = null;
            if (replayRecord !== void 0 || liveRecord !== void 0) {
              const merged = mergeCostRecords(replayRecord, liveRecord);
              const costNativeRounded = roundCost(merged.costNative);
              session = {
                ...merged,
                messages: undefined, // 内部逐消息样本不进入 JSON 响应
                breakdown: breakdownOf(merged),
                source: replayRecord !== void 0 && liveRecord !== void 0 ? "log+live" : replayRecord !== void 0 ? "log" : "live",
                costNative: costNativeRounded,
                costUsd: roundCost(merged.costUsd),
                // 滚动升级兼容：老版本客户端缓存仍读 cost/currency，这里按原生币种语义给出别名。
                cost: costNativeRounded,
                currency: merged.nativeCurrency ?? provider.currency
              };
            }

            // 今日消费：只走官方平台数据；5 分钟 TTL + single-flight，不随 UI 轮询锤内部接口。
            const today = await todayOf(provider, balanceEntry.data, timezone);

            return {
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
            };
          }));

          sendJson(res, 200, {
            ok: true,
            sessionId,
            activeProvider: live?.lastProvider ?? null,
            activeModel: live?.lastModel ?? null,
            configuredProvider: configuredProviderId,
            configuredModel: configuredModel,
            unrecognized: live?.unrecognized ?? null,
            fxCnyPerUsd: roundCost(fxCnyPerUsd()),
            summary: ledger.summary(new Date(), timezone),
            ledgerHealth: ledger.health(),
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
      handler: async (/** @type {{url?: string, method?: string}} */ req, /** @type {any} */ res) => {
        if (rejectUnauthorizedRequest(ctx, req, res)) return;
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
            nativeCurrency: entry.nativeCurrency,
            time: entry.time,
            costNative: entry.costNative,
            costUsd: entry.costUsd,
            // 滚动升级兼容别名（deprecated，新客户端只读 costNative/nativeCurrency）。
            currency: entry.nativeCurrency,
            cost: entry.costNative,
            priced: entry.priced !== false,
            unpricedReason: entry.unpricedReason ?? null,
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

  // ---- 余额强刷路由（POST，有外部副作用；GET state 不再触发强刷）----------
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/billing-glass/refresh-balance",
      handler: async (/** @type {{url?: string, method?: string}} */ req, /** @type {any} */ res) => {
        if (rejectUnauthorizedRequest(ctx, req, res)) return;
        try {
          if ((req.method ?? "GET").toUpperCase() !== "POST") {
            sendJson(res, 405, { ok: false, error: "method-not-allowed", message: "refresh-balance 只接受 POST" });
            return;
          }
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
          const entry = await balanceOf(provider, true);
          for (const key of todayCache.keys()) {
            if (key.startsWith(`${provider.id}:`)) todayCache.delete(key);
          }
          sendJson(res, 200, {
            ok: true,
            providerId: provider.id,
            balance: entry.data === null ? null : {
              total: entry.data.total,
              granted: entry.data.granted,
              toppedUp: entry.data.toppedUp,
              available: entry.data.available
            },
            balanceError: entry.error
          });
        } catch (error) {
          ctx.logger.warn("dsh-billing-glass: refresh-balance failed");
          ctx.logger.warn(error);
          sendJson(res, 502, { ok: false, error: "unavailable", message: error instanceof Error ? error.message : String(error) });
        }
      }
    }),
    "dsh-billing-glass: refresh balance route"
  );

  // ---- 定价校验路由（POST，有外部请求与快照落盘副作用）-------------------
  const REFRESH_MIN_INTERVAL_MS = 60 * 1000;
  const lastRefreshAt = new Map(); // providerId -> timestamp（防抖）

  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: "/api/billing-glass/refresh-pricing",
      handler: async (/** @type {{url?: string, method?: string}} */ req, /** @type {any} */ res) => {
        if (rejectUnauthorizedRequest(ctx, req, res)) return;
        try {
          if ((req.method ?? "GET").toUpperCase() !== "POST") {
            sendJson(res, 405, { ok: false, error: "method-not-allowed", message: "refresh-pricing 只接受 POST" });
            return;
          }
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

export { name, inject, apply, rejectUnauthorizedRequest };
