# 0003 — 上游漂移监控的设计（三类漂移 + 契约哨兵）

状态：已采纳 · 日期：2026-08-23

## 背景

本插件依附一个明确宣布「1.0 之前可自由破坏兼容」的上游（dsh AGENTS.md
"foundation over blast radius"）。v0.3.0 排查发现三处静默错位：pi-ai 目录
版本、官方定价页布局、新模型定价缺失——全部靠人肉排查发现。

## 决策

`scripts/check-upstream.mjs` 每日监控四类信号，分级处理：

| 信号 | 判定 | 处置 |
| --- | --- | --- |
| pi-ai 版本 | Harness 最新 release 的 llm-pi-ai 需求 vs 插件 devDep | **drift**（自动 Issue） |
| 目录内容 | 用上游 pi-ai 数据重建目录 vs 已提交 catalog | **drift** |
| DeepSeek 价格政策 | 官方定价页解析 vs 内置政策链 | **drift** |
| 契约哨兵 | 4 个接缝锚点文件的 sha256 基线（事件词汇表/持久化契约/TokenUsage/deepseek README） | advisory（人工复查，不计 drift） |

另含**迁移机会探测**：对 llm types / deepseek README 做
usage/billing/cost/spend 关键词行增量扫描——官方若出现正式用量 API，
提示整体迁移、弃用定价页爬虫。

## 关键取舍

1. 哨兵变化**不自动算漂移**：文档措辞调整也会改 hash，误报会训练用户忽略
   Issue；因此只列区块要求人工复查。
2. 基线文件 `scripts/upstream-sentinels.json` **提交入库**：与代码同审计、
   diff 可见；CI artifact 方案无法在本地复现对比。
3. 定时任务失败记 `CHECK_FAILED` 而非漂移：网络抖动不应制造假 Issue；
   代价是连续失败可能掩盖真漂移，由报告中的失败清单兜底提醒。
4. workflow 按 title 去重建 Issue、无漂移自动关旧 Issue——告警必须能自愈，
   否则会退化成噪音。

## 后果

- 漂移从「事后人肉排查」变成「次日 Issue 提醒」。
- 监控脚本本身依赖 GitHub raw/API 与 npm registry 可用性（低频，可接受）。
