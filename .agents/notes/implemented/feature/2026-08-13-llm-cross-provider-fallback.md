# Agent Note: Cross-provider fallback on request recovery

Status: implemented

English | [中文](2026-08-13-llm-cross-provider-fallback.zh.md)

## Problem

`dsh-llm-retry` recovers a failed model request on the *same* provider route: it schedules backoff and returns `{ kind: 'retry' }`, and the agent loop re-dispatches on the route it already used. A terminal failure that retries cannot help, a dead local server, an exhausted cloud endpoint, a route whose model keeps overflowing, leaves the step to fail. Routing between providers (local ↔ cloud) is structural in the harness (per agent, per auxiliary LLM call), so a deployment that wants "fall back to the other model on failure" had no mechanism.

## Decision

`RequestErrorAction` carries an optional route: `{ kind: 'retry'; provider?: string; model?: string }`. A `retry` with no route keeps the current behavior; `provider` and `model` set together retry that one attempt on the alternate route.

The agent loop threads that route as a single-attempt `failover` override into `buildRequest`. The override becomes the request's seed route, taking precedence over the persisted header, and is cleared after use, so the next step reverts to the agent's declared route. The override re-enters the `agent/request` waterfall unchanged, so a middleware can still replace the route. Reasoning effort is not inherited from the source route: the fallback model resolves its own defaults.

The `dsh-llm-fallback` plugin owns the rules. Registered after `dsh-llm-retry`, it runs only when same-route retries delegate downstream (exhausted, non-retryable, or no policy). Each rule is directional, `provider` → `toProvider`/`toModel`, with an optional `codes` filter defaulting to `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `CONTEXT_WINDOW_EXCEEDED`, and `QUOTA`, and a self-target rule is rejected at load. A match appends the durable `llm/fallback` event (carrying either the `failure` or a cooldown `preempted: true`) and returns the failover retry; no match delegates to downstream recovery. Pathological rule graphs, per-request hop bounds, and per-provider cooldown preemption are owned by the [failover-guards decision](2026-08-13-llm-fallback-failover-guards.md).

## Scope

Failover is a **single-attempt route swap**, not a persistent re-route: the agent's durable route is unchanged, and the request header/context change events already record the swapped route. Same-route retry ordering, backoff, and the retry policy stay owned by `dsh-llm-retry`.

## Alternatives considered

**Persistent re-route on failure.** Rejected: the agent's declared route is durable state; silently moving it would leak one failed request into every later turn.

**Put failover inside `dsh-llm-retry`.** Rejected: retry is same-route backoff; failover is a deployment-owned route policy, and separate plugins keep the waterfalls ordered by composition instead of by one plugin's internal logic.

## Consequences

A deployment composes availability policy as data (`rules`), while the loop change stays a single-attempt override with no durable rerouting. The error recovery waterfall gains one listener that delegates cleanly when no rule matches.

## Verification

`fallback.spec.ts` drives the full loop: terminal source failure retried once on the fallback route with the durable event recorded, dormant posture with no rules, code filtering, explicit code overrides, provider filtering, and downstream delegation when no rule names the failed provider.
