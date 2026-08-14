# Agent Note: Failover-pathology guards in llm-fallback

Status: implemented

English | [中文](2026-08-13-llm-fallback-failover-guards.zh.md)

## Problem

Cross-provider fallback (`dsh-llm-fallback`) retried a terminal request failure on another route from a stateless error listener. Two failure modes followed: cyclic rule graphs (A→B→A) retried forever inside the agent loop's unbounded retry loop, and a persistently down or budget-exhausted source provider was still called first on every later request, failing once per step before the retry route engaged.

## Decision

The plugin keeps per-instance in-memory state keyed by the requesting agent and step, plus a per-provider cooldown map:

- **Hop cap and tried-target dedup.** Each `agent/request-error` retry it emits is counted against a per-`agentId:turn:step` chain; beyond `maxFallbacks` (default 3) no further retry is emitted, and a target route already attempted in the chain (the failing source is seeded as attempted) is never re-attempted. Entries expire after a fixed 60s retention, orders of magnitude beyond a live chain.
- **Provider cooldown with request-path preemption.** A failover whose code is in `cooldownCodes` (provider- or account-level conditions: `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `QUOTA`) marks the source provider unhealthy for `cooldownMs` (default 10s). An `agent/request` listener rewrites the route of any subsequent request naming a cooled-down provider to the first matching rule's target before dispatch, so the dead route is not called at all. Request-level failures (`CONTEXT_WINDOW_EXCEEDED`) deliberately do not cooldown: the next request may fit.
- **Default codes widened.** `CONTEXT_WINDOW_EXCEEDED` and `QUOTA` join `DEFAULT_FALLBACK_CODES`, matching upstream behavior where overflow is always fallback-eligible and exhausted balance is rate-limit-class.
- **Durable record.** `llm/fallback` now records either a `failure` (a failure-triggered failover) or `preempted: true` (a cooldown preemption), exactly one per event; the invariant companion enforces the mutual exclusion.

## Alternatives considered

**Steer only at the error path (status quo).** Rejected: the error listener cannot prevent the wasted call it is reacting to; preemption belongs at `agent/request`.

**Cooldown for every failover code.** Rejected: cooling a provider after a context overflow would wrongly divert the next, smaller request away from it.

**LiteLLM-style `allowed_fails` gating.** Rejected for now: it requires cross-request failure counters and a retry-ordering contract; the hop cap plus cooldown already prevent the harmful loops.

## Consequences

A failing primary costs at most one wasted call per cooldown window instead of one per step, and cyclic rule graphs terminate instead of hanging the turn. The request-path listener runs on every request but costs one map lookup when no provider is cooling.

## Verification

`fallback.spec.ts` pins the hop cap across a three-rule chain, ping-pong termination via tried targets, cooldown preemption routing the next agent's request without touching the cooled provider, no-cooldown after context overflow, QUOTA/CONTEXT defaults, and schema rejection of non-positive guard tunables.
