# Agent Note: 请求恢复上的跨提供方故障转移

Status: implemented

[English](2026-08-13-llm-cross-provider-fallback.md) | 中文

## 问题

`dsh-llm-retry` 在*同一*提供方路由上恢复失败的模型请求：它安排退避并返回 `{ kind: 'retry' }`，agent 循环在已用过的路由上重新派发。重试帮不上忙的终止性失败，宕机的本地服务器、耗尽的云端端点、模型持续溢出的路由，只会让 step 失败。提供方间路由（本地 ↔ 云端）在 harness 中是结构性的（按 agent、按辅助 LLM 调用），因此想“失败时回退到另一个模型”的部署此前没有任何机制。

## 决策

`RequestErrorAction` 携带可选路由：`{ kind: 'retry'; provider?: string; model?: string }`。不带路由的 `retry` 保持现有行为；`provider` 与 `model` 同时设置时，把这一次尝试重试到备用路由。

agent 循环把该路由作为单次 `failover` 覆盖传入 `buildRequest`。覆盖成为请求的种子路由，优先于持久化 header，并在用完后清除，因此下一步回退到 agent 声明的路由。覆盖原样重新进入 `agent/request` 瀑布，中间件仍可替换路由。reasoning effort 不从源路由继承：故障转移模型解析自己的默认值。

`dsh-llm-fallback` 插件持有规则。它注册在 `dsh-llm-retry` 之后，只在同路由重试向下游委托（耗尽、不可重试或无策略）时运行。每条规则是单向的，`provider` → `toProvider`/`toModel`，可选的 `codes` 过滤默认包含 `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`CONTEXT_WINDOW_EXCEEDED` 与 `QUOTA`，自指规则在加载时被拒绝。匹配时追加持久事件 `llm/fallback`（携带 `failure` 或冷却 `preempted: true` 二者之一）并返回故障转移重试；不匹配则委托给下游恢复。病态规则图、每次请求的跳数上限与按提供方的冷却抢占由[故障转移防护决策](2026-08-13-llm-fallback-failover-guards.md)负责。

## 范围

故障转移是**单次路由替换**，不是持久改道：agent 的持久路由不变，请求 header/上下文变更事件已记录替换后的路由。同路由重试顺序、退避与重试策略仍归 `dsh-llm-retry` 所有。

## 备选方案

**失败后持久改道。** 拒绝：agent 声明的路由是持久状态；静默改道会让一次失败的请求泄漏进之后的每一回合。

**把故障转移并入 `dsh-llm-retry`。** 拒绝：重试是同路由退避；故障转移是部署持有的路由策略，插件分离能让瀑布顺序由组合决定，而不是由一个插件的内部逻辑决定。

## 后果

部署把可用性策略组合为数据（`rules`），而循环改动只是单次覆盖、无持久改道。错误恢复瀑布新增一个监听器，在没有规则匹配时干净地向下游委托。

## 验证

`fallback.spec.ts` 驱动完整循环：终止性源失败在故障转移路由上重试一次并记录持久事件、无规则时的休眠姿态、code 过滤、显式 code 覆盖、提供方过滤，以及没有规则点名失败提供方时向下游委托。
