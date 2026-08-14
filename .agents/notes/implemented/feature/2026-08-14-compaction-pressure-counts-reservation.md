# Agent Note: Compaction pressure counts the reserved completion

Status: implemented

English | [中文](2026-08-14-compaction-pressure-counts-reservation.zh.md)

## Problem

The proactive pressure threshold compared `ctx.tokenMeter.measure()` (the prompt envelope) against `floor(contextWindow × thresholdRatio)`. Providers reject a request when the prompt plus `max_tokens` (the reserved completion) exceeds the window, so a large default reservation leaves a dead band where the provider rejects before the harness compacts. With the DeepSeek adapter default `maxTokens: 256000` and a 1,048,576 provider window, the effective prompt ceiling is ~786K while a `0.8` threshold fires at ~800K: a session can cross the provider ceiling with no proactive compaction, and when overflow recovery then fails for an unrelated reason the session cannot run another turn.

## Decision

The pressure comparison adds the reserved completion to the measured prompt: `measurement.totalTokens + reservation >= thresholdTokens`. The reservation is the durable request header's effective `config.maxTokens` (adapter defaults already materialized there); before the first routed request of a session, it falls back to the owning adapter's `defaultMaxTokens`; with neither, it is `0` and the comparison keeps its previous behavior. The provider-confirmed overflow path is unchanged: it needs no reservation estimate.

## Alternatives considered

**Model-catalog `maxTokens` only.** Rejected: advisory catalogs omit it for default routes (the DeepSeek default models declare only `contextWindow`), while the request header already carries the exact value the next request would use.

**A new config key for the reservation.** Rejected: the reservation is a provider and request fact, not deployment tuning; the two fallback sources are already authoritative, and a config value could disagree with the request actually being built.

**Threshold over `contextWindow − reservation`.** Equivalent for a fixed reservation, but the additive form keeps `resolveCompactSpec` and its `thresholdTokens` untouched, so retention validation and error messages stay comparable.

## Consequences

Pressure compaction now precedes the provider ceiling whenever the reservation is known. Sessions without a routed request or a reservation-owning adapter behave exactly as before. The [after-call pressure note](../architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md) records the trigger semantics.

## Verification

Two cases in `compaction-basic.spec.ts`: a durable header `maxTokens` alone pushes the prompt-plus-reservation sum over the threshold and compacts, and an adapter `defaultMaxTokens` fallback does the same when the header records none. The compaction-basic suite (124 tests) and the host typecheck pass.
