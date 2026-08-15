/**
 * DeepSeek 官方价格引擎（纯函数，无依赖）。
 *
 * 移植自 bpc-oss/dsh-web-billing（MIT）：https://github.com/bpc-oss/dsh-web-billing
 * （lib/pricing.js，经 dsh-deepseek-quota 简化）。保留官方政策时间表与峰谷判定。
 * 价格表策展自 DeepSeek 官方公告（https://api-docs.deepseek.com/zh-cn/quick_start/pricing/），
 * 如官方调整欢迎同步更新。
 *
 * 语义约定（与 DeepSeek 官方及 provider 适配器一致）：
 * - input      缓存未命中输入
 * - cacheRead  缓存命中输入
 * - output     输出
 * 单价单位：每 1M tokens，人民币（cny）与美元（usd）各一份。
 */

/** 峰谷判定的默认时区（北京时间）。 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

/** 官方高峰时段（本地小时，[start, end) 闭开区间）。 */
export const DEFAULT_PEAK_WINDOWS = [[9, 12], [14, 18]];

/**
 * 官方政策时间表（`since`/`until` 为生效时间范围，含时区偏移）。
 * `until: null` 表示至今仍有效；未覆盖的历史区间返回 null（fail closed）。
 * 每条政策要么是固定单价表（`prices`），要么是峰谷单价表（`peak`/`offPeak`），
 * 要么是别名映射（`aliases`，旧模型名指向当时对应模型）。
 */
export const OFFICIAL_PRICING_POLICIES = [
  {
    // 官方 2026-04-24 起旧名字指向 V4-Flash，2026-07-24 23:59 北京时间退役。
    // 该窗口内旧 alias 按当时 V4-Flash 政策解析；没有对应 V4 政策的时间段宁可未计价。
    since: "2026-04-24T00:00:00+08:00",
    until: "2026-07-24T23:59:59+08:00",
    label: "deepseek-chat / deepseek-reasoner alias → deepseek-v4-flash（退役前兼容窗口）",
    aliases: {
      "deepseek-chat": "deepseek-v4-flash",
      "deepseek-reasoner": "deepseek-v4-flash"
    }
  },
  {
    since: "2026-05-22T00:00:00+08:00",
    until: "2026-08-17T00:00:00+08:00",
    label: "V4 系列 75% 降价转永久（deepseek-v4-flash / deepseek-v4-pro 上线）",
    prices: {
      "deepseek-v4-flash": {
        cny: { input: 1, cacheRead: 0.02, output: 2 },
        usd: { input: 0.14, cacheRead: 0.0028, output: 0.28 }
      },
      "deepseek-v4-pro": {
        cny: { input: 3, cacheRead: 0.025, output: 6 },
        usd: { input: 0.435, cacheRead: 0.003625, output: 0.87 }
      }
    }
  },
  {
    since: "2026-08-17T00:00:00+08:00",
    until: null,
    label: "峰谷定价：高峰 09:00-12:00 / 14:00-18:00（北京时间），空闲时段半价",
    peak: {
      "deepseek-v4-flash": {
        cny: { input: 3, cacheRead: 0.1, output: 9 },
        usd: { input: 0.44, cacheRead: 0.014, output: 1.32 }
      },
      "deepseek-v4-pro": {
        cny: { input: 9, cacheRead: 0.3, output: 27 },
        usd: { input: 1.32, cacheRead: 0.044, output: 3.96 }
      }
    },
    offPeak: {
      "deepseek-v4-flash": {
        cny: { input: 1.5, cacheRead: 0.05, output: 4.5 },
        usd: { input: 0.22, cacheRead: 0.007, output: 0.66 }
      },
      "deepseek-v4-pro": {
        cny: { input: 4.5, cacheRead: 0.15, output: 13.5 },
        usd: { input: 0.66, cacheRead: 0.022, output: 1.98 }
      }
    }
  }
];

/** 判断政策是否在给定时刻有效（since <= time <= until，until 为 null 表示至今）。 */
export function policyActiveAt(policy, timeMs) {
  const since = Date.parse(policy.since);
  if (!Number.isFinite(since) || timeMs < since) return false;
  if (policy.until !== null && policy.until !== void 0) {
    const until = Date.parse(policy.until);
    if (Number.isFinite(until) && timeMs > until) return false;
  }
  return true;
}

/** 某时刻生效的官方政策；无政策覆盖时返回 null（fail closed）。 */
export function activePolicy(timeMs, policies = OFFICIAL_PRICING_POLICIES) {
  let active = null;
  for (const policy of policies) {
    if (policyActiveAt(policy, timeMs)) active = policy;
  }
  return active;
}

/** 该时刻是否处于高峰时段（按指定时区与窗口判定；窗口为 [start, end) 小时）。 */
export function isPeak(timeMs, timezone = DEFAULT_TIMEZONE, windows = DEFAULT_PEAK_WINDOWS) {
  let hour;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "numeric",
      minute: "numeric"
    }).formatToParts(new Date(timeMs));
    hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  } catch {
    // 非法时区等异常按非高峰处理，不阻断计价。
    hour = -1;
  }
  return windows.some(([start, end]) => hour >= start && hour < end);
}

/**
 * 归一化模型名：`deepseek/deepseek-v4-pro`、`DeepSeek-V4-Pro` →
 * `deepseek-v4-pro`。只做展示/匹配归一，不做任何猜测计价。
 */
export function normalizeModel(model) {
  if (typeof model !== "string") return "";
  const bare = model.trim().split("/").at(-1) ?? "";
  return bare.toLowerCase();
}

/**
 * 计算某模型在某一时刻的单价（双币种）。
 *
 * 解析顺序（有效期 + 政策链，fail closed）：
 * 1. 归一化模型名（去 vendor 前缀 + 小写）；
 * 2. 只在 `[since, until]` 有效期内匹配；有效期外不无限继承旧政策；
 * 3. 有效期内先从新到旧匹配显式价格表；命中 aliases 政策时按映射后的模型重新解析；
 * 4. 任何一步无价格/无别名 → 返回 null，调用方标记"未计价"。
 *
 * @param model - 模型名。
 * @param timeMs - 消息时间（epoch ms）。
 * @param opts - { timezone, peakWindows, policies }。
 * @returns { cny, usd, mode, policy } | null — mode: 'flat' | 'peak' | 'offPeak'。
 */
export function priceAt(model, timeMs, opts) {
  const { timezone = DEFAULT_TIMEZONE, peakWindows = DEFAULT_PEAK_WINDOWS, policies = OFFICIAL_PRICING_POLICIES } = opts ?? {};
  const key = normalizeModel(model);
  if (key === "") return null;
  const peak = isPeak(timeMs, timezone, peakWindows);
  const applicable = policies.filter((policy) => policyActiveAt(policy, timeMs));
  if (applicable.length === 0) return null;

  let resolveKey = key;
  for (let index = applicable.length - 1; index >= 0; index--) {
    const policy = applicable[index];
    if (policy.aliases !== void 0 && policy.aliases[resolveKey] !== void 0) {
      resolveKey = normalizeModel(policy.aliases[resolveKey]);
    }
  }

  for (let index = applicable.length - 1; index >= 0; index--) {
    const policy = applicable[index];
    const table = policy.peak !== void 0 && policy.offPeak !== void 0
      ? (peak ? policy.peak : policy.offPeak)
      : policy.prices;
    if (table !== void 0 && table[resolveKey] !== void 0) {
      const unit = table[resolveKey];
      return {
        cny: unit.cny,
        usd: unit.usd,
        mode: policy.peak !== void 0 && policy.offPeak !== void 0 ? (peak ? "peak" : "offPeak") : "flat",
        policy: { since: policy.since, label: policy.label }
      };
    }
  }
  return null;
}

/**
 * 按 TokenUsage 与单价计算费用（原生币种 + USD）与 token 拆分。
 *
 * 金额字段语义：
 * - `costNative`：供应商原生币种金额（nativeCurrency === "USD" 时等于 costUsd）。
 * - `costUsd`：美元金额，是账本聚合与跨供应商换算的唯一基准。
 * - 不再返回含义模糊的 `cost`；展示层必须显式选择币种。
 *
 * @param usage - `{ inputTokens, cacheReadTokens?, outputTokens }`（assistant/message 事件上报）。
 * @param unit - `priceAt` 返回的单价（`cny`/`usd`）。
 * @param nativeCurrency - 供应商原生币种（默认 "CNY"，当前仅支持 CNY/USD）。
 * @returns { inputTokens, cacheReadTokens, outputTokens, costNative, nativeCurrency, costUsd }。
 */
export function costOf(usage, unit, nativeCurrency = "CNY") {
  const inputTokens = usage.inputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const currency = nativeCurrency === "USD" ? "USD" : "CNY";
  const unitNative = currency === "USD" ? unit.usd : unit.cny;
  const costNative = (inputTokens * unitNative.input + cacheReadTokens * unitNative.cacheRead + outputTokens * unitNative.output) / 1e6;
  const costUsd = (inputTokens * unit.usd.input + cacheReadTokens * unit.usd.cacheRead + outputTokens * unit.usd.output) / 1e6;
  return { inputTokens, cacheReadTokens, outputTokens, costNative, nativeCurrency: currency, costUsd };
}
