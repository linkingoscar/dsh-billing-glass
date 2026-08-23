# Changelog

本项目的所有重要变更记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.4.1] - 2026-08-23

### Added
- **契约哨兵监控**（check-upstream 第 4 类检测）：对事件词汇表、持久化契约、
  TokenUsage 形状、deepseek 适配器 README 四个接缝锚点做 sha256 基线对比
  （`scripts/upstream-sentinels.json` 入库，`--update-baseline` 重录）；变化
  以 advisory 区块提示人工复查，不计入漂移。另含官方用量 API 关键词增量
  扫描——出现正式 usage/billing 接口时报告迁移机会。
- **state 路由 golden 快照**：聚合响应归一化后与基线深比较，意外契约漂移
  在测试期暴露；`UPDATE_SNAPSHOT=1` 重录（diff 须在 PR 中审查）。
- 决策档案 `docs/decisions/0001–0004`：峰谷周一口径回溯、隐含汇率与兜底
  常数、漂移监控设计、fail-closed 计价——只增不改的"为什么"记录。

### Changed
- 品牌合规（对照官方 BRAND_GUIDELINES）：双语 README 增加非官方社区插件
  声明行；徽章文案改为 "DSH-community plugin"（避免完整商标与官方背书
  暗示；项目名 dsh-* 缩写符合官方推荐用法）。
- CONTRIBUTING 新增决策文件约定与发布纪律（feature 先 -rc）。

## [0.4.0] - 2026-08-23

### Added
- **上游漂移自动监控**：`scripts/check-upstream.mjs` + 每日定时 workflow
  （`upstream-watch.yml`）。监控三类漂移——Harness 最新 release 所需的 pi-ai
  版本 vs 插件 devDep、用上游数据重建目录 vs 已提交 catalog、官方定价页 vs
  内置价格政策链；发现漂移自动创建/追加 GitHub Issue，无漂移时自动关闭遗留
  issue。本地入口 `npm run check:upstream`。
- **设置卡片**（Harness v0.1.0-rc.7+）：设置面板新增「计费悬浮卡」页，可关闭
  悬浮胶囊 / 每条消息费用角标、一键恢复悬浮卡默认位置；偏好存 localStorage。
- 视觉实验模型 `deepseek-v4-flash-vision-exp` 计价（与 v4-flash 同价同峰谷）；
  型号徽章新增 "Flash-Vision"。
- 官方隐含汇率 `impliedFxRate()`：消费统计混合币种换算不再使用写死的 7.2，
  而是取现行政策双币价之比；支持 env `DSH_BILLING_FX_CNY_PER_USD` 覆盖。
- `ledger.summary()` 每桶新增按原生币种分组的 `native` 合计——单币种账本精确
  展示，无需任何汇率换算。
- refresh-pricing 响应附带 `pageHash`（定价页内容指纹，审计用）。
- TypeScript strict 类型检查（JSDoc + checkJs，零构建安装不变）与 oxlint
  门禁进入 CI；全仓 JSDoc 注解。

### Changed
- `lib/index.js` 纯计价管道拆分至 `lib/session-costing.js`（index.js 761→541 行）。
- sync-providers 数据源探测顺序：显式参数 > 本地 Harness 安装 > devDep 兜底；
  provenance 新增 `sourceKind` 字段（CHECK 模式继承已提交值，保证跨环境一致）。
- package.json 声明 `engines: node >=20`。

## [0.3.0] - 2026-08-23

### Added
- 对齐 Harness v0.1.1-rc.x：新视觉模型、峰谷"周一至周五"限定（以 2026-08-23
  官方页脚注为准）、三列峰谷矩阵解析器重写。
- sessionPersistence 能力位守卫（`supportsRawArtifacts === false` 时降级 live-only）。
- pi-ai 目录对齐 harness 内置 0.82.1（27→25 家 provider）。

## [0.2.0] - 2026-08-15

### Added
- 多供应商自动切换（header > 配置 > 注册表默认）；27 家官方目录预置供应商。
- 定价校验按钮（DeepSeek 官方页快照对比，60s 防抖）。
- 峰谷定价政策链（2026-08-17 生效）；未知模型 fail closed（unpricedCalls）。
- append-only JSONL 消费账本（幂等/压缩/坏行修复）；今日消费走官方平台接口。
- 双语 README 与 CI 门禁（test / check:generated / pack:check）。

## [0.1.0] - 2026-08-13

### Added
- 首个可用版本：液态玻璃胶囊常驻余额展示；点击展开完整计费卡（会话费用/
  token 三桶/供应商列表）；每条消息费用角标；可拖动卡片（localStorage 记忆）。
