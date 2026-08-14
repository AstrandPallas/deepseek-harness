# Agent Note: Resumed subagent children keep their worker composition

Status: implemented

English | [中文](2026-08-14-api-proxy-resumed-worker-composition.zh.md)

## Problem

A session-backed subagent child resumed through the generic host path (cold resume through the ApiProxy, rather than owner-driven continuation) was composed like any other session: the preset its log recorded, the host default model selection, and nothing else. Only the header's `delegationDepth` survived, so the child kept its no-delegation depth guard but regained the preset's orchestrator persona and tools. A resumed worker therefore believed it was the main agent, attempted delegation, and was rejected by the depth guard with an error the model read as a contradiction.

## Decision

The ApiProxy's cold-resume setup treats a session as a subagent child when its header carries either durable child marker: `origin: 'subagent'` or a positive `delegationDepth`. For such sessions it restores the worker identity after composing the preset:

- Every child gets the fixed `subagent:delegation` runtime-context statement (`SUBAGENT_DELEGATION_CONTEXT`, re-exported from `dsh-subagent`), which states the delegated scope and that it cannot be widened. Legacy children spawned before descriptors existed get at least this identity statement.
- A valid continuable `subagent/descriptor` additionally restores the spawn-time persona (a shadowing `deployment:persona` section) and tool filter (`ctx.tools.restrict`), and the resolver now receives the inspected session when building agent options, so the descriptor's `agentProvider`/`agentModel` restore the child's own route.

Fenced `origin: 'subagent'` identities are unchanged: generic resume of those sessions still rejects with `agent-busy`, per the subagent-delivery contract. The fix serves the unfenced legacy children, which is where the identity loss actually occurred.

## Alternatives considered

**Resume only through the owner (status quo).** Rejected: the child's own session is already reachable through the generic path when its header lacks the origin marker, so the composition must be right there too.

**Apply a hardcoded generic worker persona.** Rejected: persona text is deployment configuration; the fixed delegation statement already exists for exactly this purpose, and the recorded descriptor persona is the correct source when present.

## Consequences

A resumed child never presents itself as the orchestrator again: descriptor children come back with persona, tool scope, and route; legacy children at least know they are delegated and scope-fixed. The host resolver's `agentOptions` option now takes the inspected session, which is a widening (callers that ignore the parameter are unaffected).

## Verification

`api-proxy-cold.spec.ts` gains two cases: a legacy child (depth stamp only) resumes with the delegation statement and the host default route, and a continuable child resumes with its descriptor persona, tool restriction, and recorded provider/model. Both packages' suites (api-remotes and apiproxy, 382 tests) pass, and the host build is green.
