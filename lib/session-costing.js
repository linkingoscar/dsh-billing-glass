/**
 * dsh-billing-glass — 会话费用纯管道（无 I/O、无宿主依赖，全部可单测）。
 *
 * 从 lib/index.js 拆出的计价聚合核心：
 * - attribution：request/header > message.source 两级供应商/模型归属；
 * - 计价样本：模型未知或无价格时返回 `{ priced: false }`（fail closed）；
 * - 聚合：按 messageId upsert（先回滚旧值再累加），replay/live 去重合并。
 *
 * 金额语义：costUsd 是跨供应商聚合唯一基准；costNative + nativeCurrency
 * 是供应商原生金额；不再使用含义模糊的单字段 cost。
 * @import { CostRecord, CostSample, PriceUnit, ProviderContract, SessionEventLike, TokenUsage } from "./types.js"
 */
import { matchProvider } from "./providers/registry.js";

/**
 * 从 header/config 或 message.source 里提取 OpenAI 兼容 baseURL（pi-ai 网关）。
 * @param {unknown} source
 * @returns {string|undefined}
 */
export function extractBaseUrl(source) {
  if (source === null || typeof source !== "object") return void 0;
  const record = /** @type {Record<string, unknown>} */ (source);
  for (const key of ["baseURL", "baseUrl", "base_url"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return void 0;
}

/**
 * 金额四舍五入到微元（1e-6），消除浮点累计误差。
 * @param {number} value
 * @returns {number}
 */
export function roundCost(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** 空的会话费用记录（扁平合计 + 分桶明细 + 逐消息样本，金额分原生币种与 USD）。
 * @returns {CostRecord}
 */
export function emptyCostRecord() {
  return {
    calls: 0,
    unpricedCalls: 0,
    costNative: 0,
    nativeCurrency: null,
    costUsd: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    buckets: {
      input: { tokens: 0, costNative: 0 },
      cacheRead: { tokens: 0, costNative: 0 },
      output: { tokens: 0, costNative: 0 }
    },
    messages: new Map() // messageId -> priced sample（replay/live union 去重用）
  };
}

/** 复制聚合字段与消息样本（不含 ledger 引用），用于 replay+live union。
 * @param {CostRecord} record
 * @returns {CostRecord}
 */
export function cloneCostRecord(record) {
  const clone = emptyCostRecord();
  clone.calls = record.calls;
  clone.unpricedCalls = record.unpricedCalls;
  clone.costNative = record.costNative;
  clone.nativeCurrency = record.nativeCurrency;
  clone.costUsd = record.costUsd;
  clone.inputTokens = record.inputTokens;
  clone.cacheReadTokens = record.cacheReadTokens;
  clone.outputTokens = record.outputTokens;
  clone.buckets.input.tokens = record.buckets.input.tokens;
  clone.buckets.input.costNative = record.buckets.input.costNative;
  clone.buckets.cacheRead.tokens = record.buckets.cacheRead.tokens;
  clone.buckets.cacheRead.costNative = record.buckets.cacheRead.costNative;
  clone.buckets.output.tokens = record.buckets.output.tokens;
  clone.buckets.output.costNative = record.buckets.output.costNative;
  clone.messages = new Map(record.messages);
  return clone;
}

/** 把一个已经算好的样本并入聚合记录。
 * @param {CostRecord} record
 * @param {CostSample} sample
 * @returns {void}
 */
function applySample(record, sample) {
  record.calls += 1;
  if (sample.priced === false) record.unpricedCalls += 1;
  record.costNative += sample.costNative ?? 0;
  if (typeof sample.nativeCurrency === "string") record.nativeCurrency ??= sample.nativeCurrency;
  record.costUsd += sample.costUsd ?? 0;
  record.inputTokens += sample.inputTokens ?? 0;
  record.cacheReadTokens += sample.cacheReadTokens ?? 0;
  record.outputTokens += sample.outputTokens ?? 0;
  record.buckets.input.tokens += sample.inputTokens ?? 0;
  record.buckets.input.costNative += sample.bucketCostNative?.input ?? 0;
  record.buckets.cacheRead.tokens += sample.cacheReadTokens ?? 0;
  record.buckets.cacheRead.costNative += sample.bucketCostNative?.cacheRead ?? 0;
  record.buckets.output.tokens += sample.outputTokens ?? 0;
  record.buckets.output.costNative += sample.bucketCostNative?.output ?? 0;
}

/** 原生币种单价（当前仅 CNY/USD；OpenRouter 的 credits 按 1:1 用 USD 单价）。
 * @param {PriceUnit} unit
 * @param {string} currency
 * @returns {{input: number, cacheRead: number, output: number}}
 */
function nativeUnitOf(unit, currency) {
  return currency === "USD" || currency === "credits" ? unit.usd : unit.cny;
}

/**
 * canonical attribution pipeline：live/replay 共用同一优先级。
 * provider/baseURL：request/header > message.source；model：request/header > message.source。
 * 两个来源都没有 model 时返回 model: null（fail closed，绝不拿 defaultModel 计账）。
 * @param {SessionEventLike} event
 * @param {{provider?: unknown, model?: unknown, baseURL?: unknown}|null} lastHeader 最近一次 request/header 的 config。
 * @returns {{provider: ProviderContract|null, model: string|null}}
 */
export function resolveMessageContext(event, lastHeader) {
  const header = lastHeader !== null && typeof lastHeader === "object" ? lastHeader : null;
  const source = event?.data?.message?.source ?? null;
  const providerId = header?.provider ?? source?.provider;
  const baseUrl = extractBaseUrl(header) ?? extractBaseUrl(source);
  const provider = matchProvider(providerId, baseUrl);
  const headerModel = typeof header?.model === "string" && header.model !== "" ? header.model : null;
  const sourceModel = typeof source?.model === "string" && source.model !== "" ? source.model : null;
  return { provider, model: headerModel ?? sourceModel };
}

/**
 * 把一条 assistant/message 事件计价，返回该条消息的费用样本（纯计算，不累加）。
 * 模型未知（"model_unknown"）或模型无价格（"pricing_unknown"）都返回
 * `{ priced: false, ... }`：计费系统 fail closed——绝不静默按 0 元或默认模型计费。
 * @param {CostRecord} _record 未直接使用；保留签名以聚合上下文语义。
 * @param {SessionEventLike} event
 * @param {ProviderContract} provider 归属到的供应商。
 * @param {{provider: ProviderContract|null, model: string|null}} context attribution 结果。
 * @returns {CostSample|null} usage 缺失时返回 null。
 */
export function priceEventInto(_record, event, provider, context) {
  const usage = event.data?.usage;
  if (usage === void 0 || usage === null) return null;
  if (typeof usage.outputTokens !== "number" && typeof usage.inputTokens !== "number") return null;
  const model = context?.model ?? null;
  const inputTokens = usage.inputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const bucketCostNative = { input: 0, cacheRead: 0, output: 0 };
  /** @type {CostSample} */
  let sample;
  if (model === null || model === "") {
    sample = {
      priced: false,
      unpricedReason: "model_unknown",
      model: null,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      costNative: 0,
      nativeCurrency: provider.currency,
      costUsd: 0,
      bucketCostNative
    };
  } else {
    const unit = provider.priceAt(model, event.time ?? Date.now());
    if (unit === null || unit === void 0) {
      sample = {
        priced: false,
        unpricedReason: "pricing_unknown",
        model,
        inputTokens,
        cacheReadTokens,
        outputTokens,
        costNative: 0,
        nativeCurrency: provider.currency,
        costUsd: 0,
        bucketCostNative
      };
    } else {
      const priced = provider.costOf(usage, unit);
      const nativeCurrency = priced.nativeCurrency ?? provider.currency ?? "USD";
      const unitNative = nativeUnitOf(unit, nativeCurrency);
      bucketCostNative.input = (priced.inputTokens * unitNative.input) / 1e6;
      bucketCostNative.cacheRead = (priced.cacheReadTokens * unitNative.cacheRead) / 1e6;
      bucketCostNative.output = (priced.outputTokens * unitNative.output) / 1e6;
      sample = { ...priced, model, priced: true, bucketCostNative };
    }
  }
  return sample;
}

/** 从聚合记录中减去一个 sample（upsert 旧值回滚用）。
 * @param {CostRecord} record
 * @param {CostSample} sample
 * @returns {void}
 */
function subtractSample(record, sample) {
  record.calls -= 1;
  if (sample.priced === false) record.unpricedCalls -= 1;
  record.costNative -= sample.costNative ?? 0;
  record.costUsd -= sample.costUsd ?? 0;
  record.inputTokens -= sample.inputTokens ?? 0;
  record.cacheReadTokens -= sample.cacheReadTokens ?? 0;
  record.outputTokens -= sample.outputTokens ?? 0;
  record.buckets.input.tokens -= sample.inputTokens ?? 0;
  record.buckets.input.costNative -= sample.bucketCostNative?.input ?? 0;
  record.buckets.cacheRead.tokens -= sample.cacheReadTokens ?? 0;
  record.buckets.cacheRead.costNative -= sample.bucketCostNative?.cacheRead ?? 0;
  record.buckets.output.tokens -= sample.outputTokens ?? 0;
  record.buckets.output.costNative -= sample.bucketCostNative?.output ?? 0;
}

/** 按 messageId upsert sample：同一 id 重复到达时先回滚旧值，整个 pipeline 幂等。
 * @param {CostRecord} record
 * @param {string} messageId
 * @param {CostSample} sample
 * @returns {void}
 */
export function upsertMessageSample(record, messageId, sample) {
  if (typeof messageId !== "string" || messageId === "") return;
  const previous = record.messages.get(messageId);
  if (previous !== void 0) subtractSample(record, previous);
  applySample(record, sample);
  record.messages.set(messageId, sample);
}

/** replay + live 按 (sessionId,messageId) 去重后合并；live 独有消息补进 replay 聚合。
 * @param {CostRecord|undefined} replayRecord
 * @param {CostRecord|undefined} liveRecord
 * @returns {CostRecord}
 */
export function mergeCostRecords(replayRecord, liveRecord) {
  const merged = replayRecord !== void 0 ? cloneCostRecord(replayRecord) : emptyCostRecord();
  if (liveRecord !== void 0) {
    for (const [messageId, sample] of liveRecord.messages) {
      if (merged.messages.has(messageId)) continue;
      upsertMessageSample(merged, messageId, sample);
    }
  }
  return merged;
}

/** 每桶 { label, tokens, rate, subtotal }；rate/subtotal 为原生币种（每 1M / 金额）。
 * @param {CostRecord} record
 * @returns {{label: string, tokens: number, rate: number, subtotal: number}[]}
 */
export function breakdownOf(record) {
  /** @type {{label: string, key: "input"|"cacheRead"|"output"}[]} */
  const parts = [
    { label: "输入(未命中)", key: "input" },
    { label: "缓存命中", key: "cacheRead" },
    { label: "输出", key: "output" }
  ];
  return parts.map(({ label, key }) => {
    const bucket = record.buckets[key];
    const tokens = bucket.tokens;
    const subtotal = bucket.costNative;
    const rate = tokens > 0 ? roundCost((subtotal / tokens) * 1e6) : 0;
    return { label, tokens, rate, subtotal: roundCost(subtotal) };
  });
}
