# dsh-llm-fallback

[English](README.md) | 中文

基于 agent 循环请求扩展点的跨提供方故障转移。同路由重试（`dsh-llm-retry`）耗尽后，方向性规则可以把一次终止性失败重试到另一条提供方路由；发生提供方级失败后，源路由进入冷却，后续指向它的请求在它恢复前会被抢先改写。

## 功能

插件持有两个监听器：

- 在 `agent/request-error` 上（组合顺序位于 `dsh-llm-retry` 之后，因此同路由重试先跑），每条 `provider` 匹配失败请求所属提供方、且 `codes` 包含该失败 code 的规则会追加持久事件 `llm/fallback`，并返回 `{ kind: 'retry', provider, model }` 动作指名故障转移路由。agent 循环在故障转移路由上重新派发这次尝试。
- 在 `agent/request` 上，路由指向冷却中提供方的请求会在派发前被改写为第一条匹配规则的目标，不再调用冷却中的提供方。只有 `cooldownCodes` 里的 code 才会触发冷却，这些是提供方或账户级状况，而不是上下文溢出这类请求级状况。

故障转移链有界：每条请求链最多 `maxFallbacks` 跳，链中已尝试过的路由不会再次尝试，因此环形规则图（A→B→A）会终止而不是循环。

## 配置

```yaml
- id: llm-fallback
  name: '@deepseek-ai/dsh-llm-fallback'
  config:
    rules:
      - provider: muse-glimmer        # source route whose terminal failures fail over
        toProvider: deepseek-official # fallback route
        toModel: deepseek-v4-pro      # fallback model
        # codes: [SERVER, TIMEOUT]    # optional; defaults to RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/CONTEXT_WINDOW_EXCEEDED/QUOTA
    # maxFallbacks: 3                 # optional; cap on failover hops per request chain
    # cooldownMs: 10000               # optional; 0 disables preemption
    # cooldownCodes: [RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, QUOTA]  # optional; codes that cool the source down
```

代码块中的注释保持英文以与英文版逐字节一致。规则集为空是休眠姿态：什么都不注册，之后配置了规则的层会实时注册监听器。`toProvider` 等于 `provider` 的规则在加载时被拒绝。

## 模型体验

- **Token**，每次终止性源失败在故障转移路由上多一次请求尝试；故障转移模型使用自己的上下文与 effort 默认值（不继承源模型的 reasoning effort）。被抢先的请求不花源提供方任何成本。
- **KV 缓存 / 上下文**，agent 的持久路由不变；故障转移是记录在请求 header/上下文变更与 `llm/fallback` 事件里的单次覆盖。
- **持久性**，`llm/fallback` 记录 `turn`、`step`、`provider`、`toProvider`、`toModel`，以及 `failure`（失败触发的故障转移）或 `preempted: true`（冷却抢占）二者之一；请求 header 与上下文变更事件记录故障转移路由本身。
