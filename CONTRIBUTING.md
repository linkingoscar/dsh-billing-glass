# 贡献指南

感谢关注 dsh-billing-glass！这是一个 DeepSeek Harness Web GUI 的计费悬浮插件，
零外部运行时依赖、安装即用。提交变更前请通读本指南。

## 环境

- Node.js >= 20（建议 22 LTS）
- 无需构建工具链：`npm ci` 只安装 devDependencies（类型检查/lint/目录同步用）

## 常用脚本

```sh
npm test                    # 单元 + 渲染冒烟 + 路由集成测试（node --test）
npm run lint                # oxlint（correctness）
npm run typecheck           # TypeScript strict（JSDoc checkJs，无产物）
npm run build:client        # src/client/* → lib/client.js
npm run sync:providers      # pi-ai 官方目录 → lib/providers/catalog.generated.js
npm run sync:providers:check# CI 用：保留 generatedAt/sourceKind 重生成，由 git diff 验证
npm run check:generated     # 两条生成链与源码一致性验证
npm run check:upstream      # 上游漂移检测（Harness/pi-ai/官方价格）
npm run pack:check          # 发布包内容检查
```

## 项目约定

### 金额语义（最重要）

- `costUsd` 是跨供应商聚合的**唯一基准**；`costNative + nativeCurrency` 是
  供应商原生金额；禁止使用含义模糊的单字段 `cost`（仅作为旧客户端兼容别名）。
- 消费统计展示：单币种直接用 `ledger.summary()` 的 `native` 原生合计；
  混合币种才按官方隐含汇率换算并标注 ≈。

### Fail closed

- 目录里没有的模型**绝不按 0 元计费**——标记 unpriced 并在 UI/账本暴露。
- 解析器（官方定价页等）结构不符时返回 null 引导人工处理，不猜测。

### 生成文件

- `lib/client.js` 由 `scripts/build-client.js` 生成——改 `src/client/*` 后重跑构建；
  src/client 只支持有限语法（命名 import/export，无动态 import / default export）。
- `lib/providers/catalog.generated.js` 由 `scripts/sync-providers.js` 生成——勿手改。
- 两份产物都受 `check:generated` 门禁保护。

### 类型与质量

- 所有 JS 文件参与 `tsc --noEmit` strict 检查（JSDoc 注解，无构建步骤）。
- 新增导出必须带 JSDoc（参数/返回类型）；禁止 @ts-nocheck/@ts-ignore。
- 提交前本地跑齐：`npm test && npm run typecheck && npm run lint && npm run check:generated`。

### 上游兼容

- 插件依赖若干宿主契约（session/event 形状、webServer.register、slots、
  sessionPersistence 能力位）。触碰这些区域时请保持向后兼容探测写法
  （feature detection），不要假设宿主版本。
- **重大决策须附决策文件**：`docs/decisions/NNNN-<slug>.md`（模板：背景 /
  决策 / 备选方案 / 后果），只增不改；CHANGELOG 记"改了什么"，decisions
  记"为什么"。参考现有 0001–0004。
