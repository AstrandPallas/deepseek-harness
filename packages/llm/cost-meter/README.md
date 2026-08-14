# @deepseek-ai/dsh-cost-meter

English | [中文](README.zh.md)

Session-plane USD cost ledger. Prices resolve from the hot-reloaded `cost-meter` settings section (per provider route and model, USD per 1M tokens); the fold reads only the durable `assistant/message` usage events already in the session log, so cost is replay-exact and adds no durable state of its own. A read-only `cost` tool reports the session totals, and an optional per-session `budgetUsd` ceiling rejects further requests once a session exceeds it.

## What it does

- On every session, folds each model-sourced `assistant/message` event's `usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) through the configured rates. Unlisted routes and omitted rate fields price at zero.
- Registers the `cost` tool: reports the session's USD total and token breakdown, read-only and concurrency-safe.
- When `budgetUsd` is set, an `agent/request` guard fails the next request loudly once the session cost exceeds the ceiling, no further tokens are purchased, and the failure is not retryable by the LLM recovery plugins.

## Configuration

Settings section `cost-meter` (hot-reloaded; the web settings page can edit it):

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

The plugin also accepts the same shape as its cordis.yml `config`; the settings section wins per request. Negative rates and budgets are rejected at the schema boundary.

## Model experience

- **Tokens**, the `cost` tool returns two short lines (USD total; input/output/cache token counts). Budget enforcement turns the next model request into a loud per-session error naming the ceiling and current cost.
- **KV cache / context**, no durable events added; the fold derives from already-logged usage, so nothing here affects replay or compaction.
- **Durability**, zero durable writes. The reported cost depends only on the session log and the configured rates, both already durable.

## Known Limitations and Deferred Work

- **No per-provider attribution in the report**, the tool reports session totals; a per-route breakdown would belong in a richer report format.
- **No web surface**, the browser shows the token-meter's units, not this plugin's USD totals; the `cost` tool is the only reader.
