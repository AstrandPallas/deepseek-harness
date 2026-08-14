# dsh-llm-fallback

Cross-provider fallback on the agent loop's request extension points. After same-route retries (`dsh-llm-retry`) exhaust, a directional rule can retry a terminal failure on another provider route; after a provider-level failure, the source route is cooled down and further requests on it are preempted until it recovers.

## What it does

The plugin owns two listeners:

- On `agent/request-error`, registered after `dsh-llm-retry` in the composition, so same-route retries run first, each rule whose `provider` matches the failed request's provider and whose `codes` include the failure code appends a durable `llm/fallback` event and returns a `{ kind: 'retry', provider, model }` action naming the fallback route. The agent loop re-dispatches that attempt on the fallback route.
- On `agent/request`, a request whose route names a provider still in cooldown is rewritten to the first matching rule's fallback route before dispatch, without calling the cooled-down provider. Cooldown is set only for codes in `cooldownCodes`, provider- or account-level conditions, not request-level ones like a context overflow.

Failover chains are bounded: at most `maxFallbacks` hops per request chain, and a route already attempted in the chain is never re-attempted, so cyclic rule graphs (A→B→A) terminate instead of looping.

## Configuration

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

An empty rule set is the dormant posture: nothing registers, and a later configuration supplying rules registers the listeners live. A rule whose `toProvider` equals its `provider` is rejected at load.

## Model experience

- **Tokens**, one extra request attempt per terminal source failure, on the fallback route; the fallback model's own context/effort defaults apply (the source model's reasoning effort is not inherited). Preempted requests cost the source provider nothing.
- **KV cache / context**, no change to the agent's durable route; the failover is a single-attempt override recorded in the request header/context change and the `llm/fallback` event.
- **Durability**, `llm/fallback` records `turn`, `step`, `provider`, `toProvider`, `toModel`, and exactly one of `failure` (a failure-triggered failover) or `preempted: true` (a cooldown preemption); the request header and context change events record the fallback route itself.
