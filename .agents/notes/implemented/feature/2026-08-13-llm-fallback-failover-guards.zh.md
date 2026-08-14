# Agent Note: llm-fallback 的故障转移病理防护

Status: implemented

[English](2026-08-13-llm-fallback-failover-guards.md) | 中文

## 问题

跨提供方故障转移（`dsh-llm-fallback`）此前由无状态的错误监听器把终止性请求失败重试到另一条路由。由此产生两种故障模式：环形规则图（A→B→A）会在 agent 循环的无界重试循环里永远重试；持续宕机或预算耗尽的源提供方在每个后续请求里仍先被调用一次，每次都失败一次后才轮到重试路由。

## 决策

插件维护按发起 agent 与 step 索引的进程内状态，外加一张按提供方的冷却表：

- **跳数上限与已尝试目标去重。** 它发出的每次 `agent/request-error` 重试都计入以 `agentId:turn:step` 为键的重试链；超过 `maxFallbacks`（默认 3）后不再发出重试，且本链中已尝试过的目标路由（失败源会作为已尝试项初始化）绝不再尝试。条目在固定 60 秒保留期后过期，远超真实链的时长。
- **提供方冷却与请求路径抢占。** 故障转移的 code 属于 `cooldownCodes`（提供方或账户级状况：`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`QUOTA`）时，把源提供方标记为不健康，持续 `cooldownMs`（默认 10 秒）。`agent/request` 监听器在派发前把任何指向冷却中提供方的后续请求改写为第一条匹配规则的目标，从而完全不再调用死路由。请求级失败（`CONTEXT_WINDOW_EXCEEDED`）刻意不触发冷却：下一条请求可能放得下。
- **默认 code 集合放宽。** `CONTEXT_WINDOW_EXCEEDED` 与 `QUOTA` 加入 `DEFAULT_FALLBACK_CODES`，与上游行为一致，溢出总是可以故障转移，余额耗尽属于限流类。
- **持久记录。** `llm/fallback` 现在记录 `failure`（失败触发的故障转移）或 `preempted: true`（冷却抢占）二者之一，每条事件恰有一个；不变式伴生插件强制执行互斥。

## 备选方案

**只在错误路径上转向（现状）。** 拒绝：错误监听器无法阻止它正在响应的那次浪费调用；抢占应放在 `agent/request`。

**对所有故障转移 code 冷却。** 拒绝：上下文溢出后冷却提供方，会错误地让下一条更小的请求绕开它。

**LiteLLM 式 `allowed_fails` 门控。** 暂缓：需要跨请求的失败计数与重试顺序契约；跳数上限加冷却已足以阻止有害循环。

## 后果

失败的主路由每个冷却窗口至多浪费一次调用，而不是每个 step 一次；环形规则图终止而不是挂起回合。请求路径监听器在每次请求上运行，但没有提供方在冷却时只付出一次 map 查找。

## 验证

`fallback.spec.ts` 固定了三规则链上的跳数上限、经已尝试目标实现的乒乓终止、冷却抢占把下一个 agent 的请求直接路由到目标而不触碰冷却提供方、上下文溢出后不冷却、QUOTA/CONTEXT 默认值，以及 schema 对非正防护参数值的拒绝。
