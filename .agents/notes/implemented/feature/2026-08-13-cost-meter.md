# Agent Note: Session-plane USD cost ledger

Status: implemented

English | [中文](2026-08-13-cost-meter.zh.md)

## Problem

The token-meter counts tokens only. A hybrid deployment (paid cloud orchestrator, subscription gateway, free local workers) had no per-session dollar figure and no ceiling: spend was invisible until the billing page said so.

## Decision

A new `@deepseek-ai/dsh-cost-meter` function plugin folds every durable model-sourced `assistant/message` usage event through a price map (provider route → model → USD per 1M input/output/cache-read/cache-write tokens) from the hot-reloaded `cost-meter` settings section. The fold adds no durable events, the same log under the same rates yields the same cost. A read-only, concurrency-safe `cost` tool reports the session's USD and token totals, and an optional `budgetUsd` ceiling makes an `agent/request` guard fail the next request loudly (not retryable by the LLM recovery plugins) once the session exceeds it. Unlisted routes and omitted rate fields price at zero.

## Alternatives considered

**Extend `dsh-token-meter`.** Rejected: its measurement carries one unattributed usage baseline plus heuristic surface tokens; per-route pricing needs per-event provider/model attribution, which the meter does not retain.

**Price from provider-reported cost fields.** Rejected: not every provider reports cost, and pricing policy belongs to the deployment, not the transport.

## Consequences

Zero durable writes and replay-exact accounting; the budget guard turns overspend into a loud per-session error instead of silent billing. Cost: one event fold per tool call or guarded request.

## Verification

`cost-meter.spec.ts` folds two usage-bearing turns at mixed rates into the exact dollar figure, prices unlisted routes at zero, proves the budget guard blocks the next request before dispatch, fails the tool without an agent, and rejects negative rates/budgets at the schema boundary.
