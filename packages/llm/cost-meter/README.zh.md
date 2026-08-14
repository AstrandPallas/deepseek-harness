# @deepseek-ai/dsh-cost-meter

[English](README.md) | 中文

会话平面上的 USD 成本台账。价格来自热重载的 `cost-meter` 设置 section（按提供方路由和模型，以每 1M token 的美元计价）；汇总只读取会话日志中已经持久的 `assistant/message` 用量事件，因此成本可精确重放，且自身不新增任何持久状态。只读的 `cost` 工具报告会话总量，可选的每会话 `budgetUsd` 上限会在会话超支后拒绝后续请求。

## 功能

- 对每个会话，把每条模型来源的 `assistant/message` 事件里的 `usage`（`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`）按配置费率折算。未列出的路由和未填写的费率字段按零计价。
- 注册 `cost` 工具：报告会话的美元总量和 token 明细，只读且并发安全。
- 设置 `budgetUsd` 后，`agent/request` 守卫会在会话成本超过上限时让下一个请求大声失败，不再购买任何 token，且该失败不会被 LLM 恢复插件重试。

## 配置

`cost-meter` 设置 section（热重载，Web 设置页可直接编辑）：

```yaml
cost-meter:
  prices:
    deepseek-official:
      deepseek-v4-pro:
        input: 0.54      # USD per 1M input tokens
        output: 1.84     # USD per 1M output tokens
        cacheRead: 0.10
        cacheWrite: 0.54
  budgetUsd: 5.00        # optional per-session ceiling; omit to disable
```

代码块中的注释保持英文以与英文版逐字节一致：`input`/`output` 是每 1M 输入/输出 token 的美元价格，`budgetUsd` 是可选上限，省略则禁用。

插件也接受同样结构作为其 cordis.yml `config`；设置 section 对每次请求优先。负数费率和预算会在 schema 边界被拒绝。

## 模型体验

- **Token**, `cost` 工具返回两行简短文本（美元总量；输入/输出/缓存 token 数）。预算执行会把下一次模型请求变成明确指出上限与当前成本的、按会话的响亮错误。
- **KV 缓存 / 上下文**, 不新增持久事件；汇总从已记录的用量推导，不影响重放或压缩。
- **持久性**, 零持久写入。报告的成本只取决于会话日志和配置的费率，两者均已持久。

## 已知限制与延后工作

- **报告不含按提供方的明细**, 工具只报告会话总量；按路由拆分属于更丰富的报告格式。
- **无 Web 界面**, 浏览器展示 token-meter 的单位，而非本插件的美元总量；`cost` 工具是唯一读取入口。
