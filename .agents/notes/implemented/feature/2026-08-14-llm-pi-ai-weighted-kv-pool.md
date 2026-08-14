# Agent Note: Weighted KV-pool budgeting for shared local routes

Status: implemented

English | [中文](2026-08-14-llm-pi-ai-weighted-kv-pool.zh.md)

## Problem

Several provider routes can point at one local server (one llama.cpp process with a fixed KV pool), but each route's `maxConcurrent` cap counts only its own streams. Worker classes sized for the same pool, like a 32K lean class and a 112K deep class, could not coexist safely: the caps did not see each other, so a deep request could start beside running lean requests and overflow the shared pool, or a global cap of one serialized everything and threw away parallelism.

## Decision

`llm-pi-ai` profiles gain a weighted shared budget. A route declaring `kvUnits` and `kvPool` (both required together, with an explicit `baseURL`, and `kvUnits <= kvPool`) reserves `kvUnits` permits of one shared pool sized `kvPool`, keyed by `baseURL` across every route that declares one. The `Semaphore` grows weighted acquisition: a request queues when not enough permits are free, granting is first-fitting with head priority, so a large blocked request does not hold back smaller ones that fit, and requests of a class that fits stay first-come first-served. An aborted waiter leaves the queue without holding permits, as before.

Routes without `kvUnits` keep the existing per-route `maxConcurrent` limiter unchanged.

## Alternatives considered

**A global `maxConcurrent` across routes.** Rejected: it admits requests without regard to size, so a deep request and several lean requests could still jointly overflow the pool; weights are what make the budget honest.

**Strict FIFO for every waiter.** Rejected: a queued deep request would head-of-line block lean arrivals even while permits sat free, which is exactly the starvation the worker-class layout exists to avoid.

## Consequences

Worker classes can share one server safely: a deep request waits for lean and mid requests to drain, new lean requests slip past a waiting deep one, and the pool can never be oversubscribed by more than the declared units. The per-request cost stays one acquire/release pair; the pool registry adds one map keyed by `baseURL`.

## Verification

`semaphore.spec.ts` pins skip-blocked acquisition, FIFO among fitting requests, unit validation, and capacity rejection; `adapter.spec.ts` drives two weighted routes against a delayed mock server and pins that the deep request waits while the second lean request reaches the server first. Config resolution rejects `kvUnits` without `kvPool` or `baseURL`, and `kvUnits` above `kvPool`.
