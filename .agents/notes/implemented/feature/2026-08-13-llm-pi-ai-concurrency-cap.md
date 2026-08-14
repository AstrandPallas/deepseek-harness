# Agent Note: Per-provider concurrency cap in llm-pi-ai

Status: implemented

English | [中文](2026-08-13-llm-pi-ai-concurrency-cap.zh.md)

## Problem

A local inference server (llama.cpp with `-np 4`) has a hard slot count, but nothing bounded concurrent streams against it: sibling subagents, titles, and compaction summaries could all hit the local route at once, overflowing the KV pool and failing requests that a simple queue would have served.

## Decision

`llm-pi-ai` gains a per-provider `maxConcurrent` profile field (positive integer, optional). `PiAiAdapter.stream()` acquires a counting semaphore for the route before any network or credential work and releases it when the stream settles, holding the permit across the whole stream including every finally path. Waiters queue in arrival order; a waiter whose caller signal aborts leaves the queue and rejects with `ABORTED` without consuming a slot. The limiter is keyed per route and replaced when the configured cap changes; routes without the field stay uncapped.

## Alternatives considered

**Semaphore on `tool-subagent` only.** Rejected: subagent spawns are not the only local-model calls (session titles, compaction summarization), and the adapter is the single choke point every call already passes through.

**Server-side only.** Rejected: llama-server queues per slot anyway, but harness-side queueing keeps ordering, gives abort-while-queued semantics, and fails fast instead of relying on server timeouts.

## Consequences

At most `maxConcurrent` streams run against a capped route at once; the rest queue and start in order as slots free. Cost: one acquire/release pair per stream on capped routes and a per-route limiter entry.

## Verification

`adapter.spec.ts` drives two concurrent requests against a delayed mock server with `maxConcurrent: 1` and pins that the second never reaches the server until the first settles. `semaphore.spec.ts` pins arrival-order queueing, abort-while-queued removal without slot loss, double-release idempotence, and schema rejection of `maxConcurrent: 0`.
