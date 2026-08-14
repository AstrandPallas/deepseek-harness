# @deepseek-ai/dsh-goal-governor

[English](README.md) | 中文

目标治理器：在子 agent 工作时保持目标的自主轮次安静，但只有在循环证明自己在空转之后才这样做。有产出的轮次绝不被打断。

## 功能

按会话，插件跟踪已结束回合的两条连续计数：

- **空转计数**在回合以无工具活动结束时增长。当它达到 `idleRoundThreshold`（默认 3）且会话存在活跃子 agent 时，治理器暂停目标。
- **产出计数**在回合产生工具调用时增长。治理中，连续 `productiveRoundThreshold`（默认 2）个有产出的回合会结束治理模式，插件退到一边。

治理期间，子 agent 结算通知（`subagent-settled` inbox 消息）会短暂重新武装目标，让父级处理报告并启动下一波。该回合结束后，只要子 agent 仍在，治理器再次暂停；没有剩余子 agent 时它退出治理模式，回到普通的计数跟踪。目标完成同样会结束治理模式。

## 配置

```yaml
- id: goal-governor
  name: '@deepseek-ai/dsh-goal-governor'
  config:
    idleRoundThreshold: 3        # idle rounds before governed mode engages
    productiveRoundThreshold: 2  # productive rounds that end governed mode
```

代码块中的注释保持英文以与英文版逐字节一致：`idleRoundThreshold` 是进入治理模式前的空转回合数，`productiveRoundThreshold` 是结束治理模式的有产出回合数。

## 模型体验

间接地，通过目标服务的 `goal/change` 上下文消息。

#### KV 缓存效果

治理模式移除了子 agent 工作期间本会重复出现的空转回合，多 agent 波浪期间的上下文增长因此变慢。

## 已知限制与延后工作

- **子 agent 活跃度来自已附加会话** — 会话脱离且不带持久标记的子 agent 不会被计入。
- **进入治理要求存在活跃子 agent** — 没有子 agent 的空转循环被有意放过；插件只治理多 agent 波浪模式。
