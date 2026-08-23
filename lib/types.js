/**
 * dsh-billing-glass 共享 JSDoc 类型（仅类型，无运行时导出）。
 *
 * 这些 typedef 描述插件的核心域模型：provider 契约、价格单元、计价样本、
 * 聚合记录与宿主上下文的最小使用面。各模块通过
 * `import { /** \@type *\/ ... } from "./types.js"` 或 `@type {import("./types.js").X}`
 * 引用。
 */

/**
 * 某模型某时刻的单价（双币种，每 1M tokens）。
 * @typedef {object} PriceUnit
 * @property {{input: number, cacheRead: number, output: number}} cny 人民币单价。
 * @property {{input: number, cacheRead: number, output: number}} usd 美元单价。
 * @property {"flat"|"peak"|"offPeak"} mode 计价档位。
 * @property {{since: string, label: string}=} policy 命中的政策摘要。
 */

/**
 * provider.priceAt 的入参用量（assistant/message 事件上报）。
 * @typedef {object} TokenUsage
 * @property {number=} inputTokens 缓存未命中输入 tokens。
 * @property {number=} cacheReadTokens 缓存命中输入 tokens。
 * @property {number=} outputTokens 输出 tokens。
 */

/**
 * provider.costOf 的返回：原生金额 + USD 基准 + token 拆分。
 * @typedef {object} CostOfResult
 * @property {number} inputTokens
 * @property {number} cacheReadTokens
 * @property {number} outputTokens
 * @property {number} costNative 原生币种金额。
 * @property {string} nativeCurrency ISO 4217 或 "credits"。
 * @property {number} costUsd 跨供应商聚合唯一基准。
 */

/**
 * 单条消息的计价样本（priceEventInto 返回；priced=false 表示 fail closed）。
 * @typedef {object} CostSample
 * @property {boolean} priced
 * @property {"model_unknown"|"pricing_unknown"=} unpricedReason
 * @property {string|null} model
 * @property {number} inputTokens
 * @property {number} cacheReadTokens
 * @property {number} outputTokens
 * @property {number} costNative
 * @property {string|null|undefined} nativeCurrency
 * @property {number} costUsd
 * @property {{input: number, cacheRead: number, output: number}=} bucketCostNative
 */

/**
 * 会话费用聚合记录（每供应商一条；messages 为 messageId → 样本）。
 * @typedef {object} CostRecord
 * @property {number} calls
 * @property {number} unpricedCalls
 * @property {number} costNative
 * @property {string|null} nativeCurrency
 * @property {number} costUsd
 * @property {number} inputTokens
 * @property {number} cacheReadTokens
 * @property {number} outputTokens
 * @property {{input: {tokens: number, costNative: number}, cacheRead: {tokens: number, costNative: number}, output: {tokens: number, costNative: number}}} buckets
 * @property {Map<string, CostSample>} messages
 */

/**
 * 供应商套餐 / 费用体系描述（悬浮卡"套餐"行）。
 * @typedef {object} ProviderPlan
 * @property {"token"|"subscription"|"credit"} kind
 * @property {string} label
 * @property {number=} fee 订阅制费用。
 * @property {string=} currency 订阅制币种。
 * @property {string=} period 订阅周期。
 * @property {string=} quotaLabel 配额说明。
 */

/**
 * 余额查询结果；null 表示该供应商不支持余额查询。
 * @typedef {object|null} BalanceInfo
 * @property {number} total
 * @property {number=} granted
 * @property {number=} toppedUp
 * @property {boolean=} available
 * @property {string} currency
 */

/**
 * provider 契约（registry 注册表成员）。见 registry.js 头注释的完整说明。
 * @typedef {object} ProviderContract
 * @property {string} id 稳定标识（路由/配置键）。
 * @property {string} displayName 悬浮卡显示名。
 * @property {string} currency 计费主币种（ISO 4217）。
 * @property {string[]=} aliases Harness provider id 别名。
 * @property {string[]=} baseUrlHosts pi-ai 网关 baseURL hostname 列表。
 * @property {string=} defaultModel 展示用默认模型（绝不用于计账兜底）。
 * @property {string=} keyRef 凭证引用名（判断是否已配置 Key）。
 * @property {ProviderPlan} plan 套餐/费用体系。
 * @property {string=} accountingTimezone 今日消费的官方记账时区。
 * @property {(ctx: HostContext, config: object) => Promise<BalanceInfo>} fetchBalance 余额查询（可返回 null）。
 * @property {(model: string, timeMs: number) => PriceUnit|null} priceAt 单价查询（未知必须返回 null）。
 * @property {(usage: TokenUsage, unit: PriceUnit) => CostOfResult} costOf 计价金额。
 * @property {(ctx: HostContext, config: object, balance: BalanceInfo) => Promise<{consumed: number, source?: string}|number|null>=} todayConsumed 今日消费（可选）。
 * @property {(ctx: HostContext) => Promise<object>=} refreshPricing 定价校验（可选，DeepSeek 专用）。
 */

/**
 * 宿主上下文最小使用面（cordis ctx 的鸭子类型视图，避免依赖宿主包）。
 * @typedef {object} HostContext
 * @property {(name: string) => any} get 取宿主服务（sessionPersistence/agentDefaultModel 等）。
 * @property {(fn: () => (void | (() => void)), label?: string) => (() => void)} effect 生命周期效果。
 * @property {(event: string, fn: (...args: any[]) => void) => (() => void)} on 事件订阅。
 * @property {{warn: (...args: any[]) => void}} logger 日志。
 * @property {{resolve: (ref: string) => Promise<any>}=} credentials 凭证缝（可选）。
 * @property {{register: (route: {kind: string, path: string, handler: (req: any, res: any) => Promise<void>}) => (() => void)}} webServer Web 路由注册。
 */

/**
 * 会话事件（request/header 与 assistant/message 的使用面）。
 * @typedef {object} SessionEventLike
 * @property {string} type 事件类型。
 * @property {number=} time epoch ms。
 * @property {{header?: {config?: {provider?: unknown, model?: unknown, baseURL?: unknown}}, message?: {id?: unknown, source?: {provider?: unknown, model?: unknown, baseURL?: unknown, baseUrl?: unknown, base_url?: unknown}}, usage?: TokenUsage}} data
 */

export {};
