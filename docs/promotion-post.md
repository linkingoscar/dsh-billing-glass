# 分享帖草稿 —— DeepSeek Harness 计费悬浮卡 dsh-billing-glass

> 用途：发布到 DeepSeek 开发者社区 / Discord / 即时通讯群。发布前可按平台语气微调；
> 两张截图在仓库 docs/assets/ 下，发帖时直接附上。

---

## 标题

[dsh 插件] dsh-billing-glass：右下角液态玻璃计费悬浮卡——余额 / 会话费用 / 今日消费一瞥即得

## 正文

用 dsh web 跑长任务时最没安全感的就是不知道"烧了多少钱、还剩多少余额"，每次都要切到
platform.deepseek.com 查。所以我写了一个插件把它常驻到页面右下角：

**dsh-billing-glass —— 液态玻璃计费悬浮卡**

- 右下角玻璃胶囊常驻：状态点 + 供应商名 + 余额，点击展开完整账单卡
- 会话费用按 DeepSeek 官方峰谷政策链精确计价（含 8-17 峰谷表与政策有效期），悬停能看「tokens × 单价 = 小计」公式和三桶占比
- 每条 AI 回复的动作条上有当条费用角标，悬停看输入/缓存/输出拆分
- 配置 DEEPSEEK_PLATFORM_TOKEN 后显示官方口径"今日已消费"
- 多供应商自动跟随：会话用谁就显示谁，25 家官方目录供应商开箱即用
- 设置面板有显示开关与恢复位置按钮

三个设计上的坚持：

1. 未知模型绝不按 0 元静默计费——标记"未计价 N 条"提醒补价格，宁可少算不误导
2. 金额双轨制：跨供应商聚合用 USD，展示用原生币种，单币种场景零换算
3. 零运行时依赖，一条命令安装：

```sh
dsh plugin --profile web add github:linkingoscar/dsh-billing-glass
```

装完重启 dsh web 刷新页面即可。已在 v0.1.0-rc.5 ~ v0.1.1-rc.2 上验证。

仓库（Apache-2.0，双语 README + 真机截图）：
https://github.com/linkingoscar/dsh-billing-glass

已收录进度：awesome-dsh-plugin.com 收录 PR 审核中（#2874），合并后可在
dsh-market 等插件市场一键安装。

欢迎试用反馈 bug / PR。
