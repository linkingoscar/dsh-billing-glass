# dsh-billing-glass — 液态玻璃计费悬浮卡

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.1.0-informational)](#)
[![harness](https://img.shields.io/badge/DeepSeek%20Harness-web%20plugin-6366f1)](#)
[![GitHub](https://img.shields.io/badge/GitHub-linkingoscar%2Fdsh--billing--glass-181717)](https://github.com/linkingoscar/dsh-billing-glass)

DeepSeek Harness Web GUI 的 API 计费悬浮卡插件：**液态玻璃材质**，常驻右下角
显示供应商余额，点击展开完整计费卡（本会话费用、今日消费、token 三桶占比、
多供应商列表）。**DeepSeek 优先**，架构上为后续接入其它 API 供应商留好扩展点。

[English](README.md) | 中文

## 功能

- **玻璃胶囊常驻**：状态点 + 供应商名 + 余额，一瞥即得，不用切窗口查余额；
  点击展开完整卡片，展开卡头部可拖动（位置存 localStorage）。展开卡会自动
  避让底部导航条，并禁用横向溢出——不需要靠横向滚动条拖内容出来看。
- **即时刷新**：客户端每 10 秒轮询；DeepSeek 余额服务端缓存 TTL 10 秒
  （其它供应商 60 秒）；窗口重新聚焦、标签页切回、卡片展开时立即刷新；
  点刷新按钮会绕过缓存强制拉取当前供应商的最新余额。
- **液态玻璃材质**：`backdrop-filter` 磨砂增艳 + 半透明主题底色 + 镜面高光描边 +
  折射光斑层 + 柔和悬浮投影；自动跟随 `--dsw-*` 亮/暗主题。
- **逐条消息费用角标**：每条 assistant 消息动作条上显示当条费用小徽章
  （悬停见输入/缓存/输出 token 拆分与模型）。
- **型号代称 tag**：胶囊与展开卡显示当前模型的短标签——DeepSeek
  Pro/Flash、Moonshot K2.5/K3、GPT 5.6-Sol/5.6-Terra/5.6-Luna、Claude
  Opus-4、Gemini 2.5-Pro、Qwen 3.7-Max、GLM 5.2 等；长标签自动省略，不撑卡。
- **消费账本与统计**：持久化账本（`storages/billing-glass-ledger.json`，
  幂等、防抖原子写），展开卡显示 今日 / 本月 / 累计 消费统计
  （USD 汇总后按当前供应商币种换算）。
- **会话费用**：对每条 `assistant/message` 按官方价格政策（含 2026-08-17 峰谷）
  计价，按 `request/header` 的 provider 归属分账；持久化日志全量回放（包含安装前
  的历史）+ 实时账本兜底。悬停 ⓘ 显示「tokens × 单价 = 小计」公式。
- **今日消费**：余额差估算（`期初 − 当前`，日状态落盘）。
- **定价同步校验（按钮）**：展开卡「套餐」行的 **↻ 校验定价** 按钮，只拉取
  **当前显示的那家供应商**的官方定价源，验证计费体系是否最新（不批量刷新，
  避免对多家官网同时请求）：
  - DeepSeek：拉官方定价页（api-docs.deepseek.com）解析现行价/峰谷表/生效日期，
    与内置政策链逐项对比 → ✅ 已同步 / ⚠ 发现差异（列明细，页面快照落盘到
    `storages/billing-glass-pricing-snapshot.html` 供助手分析）/ 无法解析（页面
    改版，引导对话求助手）。60 秒防抖。
  - 官方目录供应商（其余 24 家）：提示价格随 Harness 官方目录同步
    （`scripts/sync-providers.js`），需要立即核对时引导对话求助手。
- **多供应商自动切换**：卡片自动跟随**当前正在使用的供应商**——
  会话最近请求的 provider（`request/header`）> Harness 后台配置的现行供应商
  （设置 → 模型 的 `agent-default-model`）> 注册表第一位（DeepSeek 优先）。
  展开卡底部的供应商列表可点击手动查看某个供应商，再点一次恢复自动跟随；
  配置里现行的供应商带「现行」徽章，未配 Key 的带「未配置」标记。
- **套餐 / 费用体系**：每个供应商声明自己的 `plan`（`token` 按量计费 /
  `subscription` 订阅套餐），卡片「套餐」行显示计费方式 + 当前计价档
  （标准价 / 峰时价 / 谷时价）。

- **今日消费（官方口径可选）**：默认按余额差估算（`≈` 标注）。配置
  `DEEPSEEK_PLATFORM_TOKEN` 后改用官方平台数据（`已消费` 精确值）：

  1. 登录 https://platform.deepseek.com，打开 DevTools → Console，执行
     `JSON.parse(localStorage.getItem('userToken')).value`
  2. 把结果加入 `~/.dsh/.credentials.yaml`：`DEEPSEEK_PLATFORM_TOKEN: <token>`
  3. 刷新页面；卡片今日消费自动切换为官方口径。token 过期会提示重新获取。
  失败时自动回退余额差估算，不会中断显示。

## 结构

```
dsh-billing-glass/
├── README.md
├── package.json              # dsh.bundle + dsh.client(web) 声明
├── cordis.patch.yml          # 组合包补丁层
└── lib/
    ├── index.js              # host：聚合路由 /api/billing-glass/state + 事件计费
    ├── providers/
    │   ├── registry.js       # provider 抽象与注册表（扩展点）
    │   ├── deepseek.js       # DeepSeek provider（余额/今日消费/计价）
    │   └── deepseek-pricing.js # DeepSeek 官方价格引擎（政策链 + 峰谷）
    └── client.js             # 浏览器端：液态玻璃悬浮卡（手写 bundle，无构建）
```

## 安装

从 GitHub 安装（推荐）：

```sh
dsh plugin --profile web add github:linkingoscar/dsh-billing-glass
```

本地 checkout（开发用）：

```sh
dsh plugin --profile web add link:$(pwd)
```

然后重启 `dsh web` 并刷新页面。要求 Harness 支持 `dsh plugin` 命令，且已在
**设置 → 模型** 配置 `DEEPSEEK_API_KEY`（余额查询复用这把 Key，不出本机）。

## 接入新的 API 供应商

**预置范围与 Harness 官方提供方列表完全对齐（无感）：**

- 注册表内置 **25 家供应商**（`lib/providers/catalog.generated.js`），由
  `scripts/sync-providers.js` 从 Harness 内置的 pi-ai 官方目录自动生成——
  名称、baseURL、每个模型的官方价格（USD/1M）都与 Harness 模型配置后台
  的提供方列表一致。在设置 → 模型 里选了谁、会话用了谁，悬浮卡自动切换。
- 其中 DeepSeek 用专用 provider（峰谷政策链精确计价），Moonshot /
  OpenRouter 另有公开余额接口适配；其余供应商会话费用计价照常，
  余额显示「无公开余额接口」。
- Harness 升级后重跑 `node scripts/sync-providers.js` 即同步最新目录与价格。

**官方列表之外的自定义供应商（优雅降级 + 引导闭环）：**

会话使用了 Harness 官方目录未列举的供应商（baseURL 匹配失败）时，悬浮卡
出现 ⚠ 引导条：

> 未识别的供应商 "xxx"：不在 Harness 官方提供方列表中。请在对话中告诉
> 助手它的计价方案（单价/套餐）或官方价格页链接，助手会帮你完成配置。

用户按提示在对话里给出计价方案后，即可用通用工厂
`defineOpenAiCompatProvider`（`lib/providers/openai-compat.js`）一次性接入，
之后同样永久自动。

1. 新建 `lib/providers/<vendor>.js`，实现 provider 契约（见 `registry.js` 顶部注释）：

   ```js
   export const myVendor = {
     id: "my-vendor",
     displayName: "My Vendor",
     currency: "USD",
     aliases: ["my-vendor-official"],   // Harness provider id 别名（header/配置里出现的名字）
     defaultModel: "my-model",
     keyRef: "MY_VENDOR_API_KEY",       // 凭证引用名（判断是否已配置 Key）
     plan: { kind: "token", label: "按量计费 · 官方价格" },
     // 订阅制供应商：
     // plan: { kind: "subscription", label: "Pro 套餐", fee: 20, currency: "USD", period: "月" },
     async fetchBalance(ctx) { /* 返回 { total, granted, toppedUp, available, currency } */ },
     priceAt(model, timeMs) { /* 返回 { cny, usd, mode } 单价 */ },
     costOf(usage, unit) { /* 返回 { cost, costUsd, ...tokens } */ },
     async todayConsumed(ctx, config, balance) { /* 可选，返回 number | null */ }
   };
   ```

2. 在 `registry.js` 的 `PROVIDERS` 数组注册（顺序即悬浮卡展示顺序，DeepSeek 保持第一）。
3. 在 Harness 设置 → 模型 里选择该供应商/模型，或发起一次使用该供应商的请求——
   悬浮卡即自动切换显示它的名称、套餐与费用体系。
4. 重启 `dsh web` 即生效——UI 与聚合路由自动多出一节，无需改动。

## 供应商切换信号（自动感知）

| 信号 | 来源 | 优先级 |
| --- | --- | --- |
| 会话实际使用的供应商 | `request/header` 事件（provider id 或 pi-ai 网关 baseURL） | 最高 |
| 后台配置的现行供应商 | `ctx.agentDefaultModel.currentSelection()`（设置 → 模型） | 次之 |
| 注册表默认（DeepSeek） | `PROVIDERS[0]` | 兜底 |

供应商 id 通过 `aliases` 归一（如 Harness 里 DeepSeek 的 provider id 是
`deepseek-official`）；pi-ai 网关按 baseURL hostname 匹配（`baseUrlHosts`，
如 `api.moonshot.cn` → Moonshot Kimi），未知 baseURL 不误配。

## 验证

```sh
node --check lib/index.js
node --check lib/client.js
node --check lib/providers/*.js
node --test tests/*.mjs               # 单元 + 渲染冒烟 + state 路由集成
npm pack --dry-run                    # 发布包内容校验
dsh --profile web --dump-config        # 组合树校验（bundle 行出现）
# 真机：重启 dsh web，页面右下角出现玻璃胶囊
```

## License

[Apache-2.0](LICENSE) © 2026 [linkingoscar](https://github.com/linkingoscar)

定价引擎移植自 [bpc-oss/dsh-web-billing](https://github.com/bpc-oss/dsh-web-billing)
（MIT 许可），其版权声明按 MIT 要求保留在
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
