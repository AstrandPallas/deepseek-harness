# Agent Note: Goal governor pauses idle goal loops while children work

Status: implemented

English | [中文](2026-08-14-goal-governor.zh.md)

## Problem

A goal's round driver keeps firing autonomous rounds while child agents work. A loop that settles into talk-only rounds (no tool calls) burns context and turns for nothing: it reports no progress, launches no work, and only ends when a settlement notice finally wakes it. The manual workaround, pause the goal while children are live and re-arm on settlement, proved itself across waves but is exactly the kind of mechanical policy the harness should own.

## Decision

A new `@deepseek-ai/dsh-goal-governor` host plugin watches each session's turn boundaries and inbox, and only engages after the waste is proven:

- **Normal mode.** Every completed turn without a tool call advances an idle streak; any productive turn resets it. When the streak reaches `idleRoundThreshold` (default 3) AND the session has live children (attached sessions with the durable child markers), the governor calls the goal service's `pause` and enters governed mode. No children, no engagement: an idle loop with no agents in flight is left alone.
- **Governed mode.** A `subagent-settled` inbox insert re-arms the goal via `resume`, so the round driver processes the report exactly once. After that turn settles, the governor pauses again while children or unprocessed settlements remain, and exits to normal mode when none remain, when the goal completes, or after `productiveRoundThreshold` (default 2) consecutive productive rounds.
- The governor writes nothing itself: every pause and resume is a durable `goal/change` committed by the goal service, so replay stays consistent.

## Alternatives considered

**Always pause while children are live.** Rejected: a loop that manages waves with productive rounds (re-planning, tool work between launches) would be interrupted, turning the governor into new friction instead of a waste guard.

**Count context growth instead of turns.** Rejected: token growth is a lagging proxy that varies with model verbosity; the tool-activity streak is the direct signal for "this round did nothing".

## Consequences

Idle multi-agent waves stop consuming rounds and context; settlement processing still runs once per report, and replacement launches happen in the same armed window. Deployments that want a hair-trigger or a slower exit tune the two thresholds; the defaults keep the governor out of the way.

## Verification

`goal-governor.spec.ts` pins six behaviors against a goal double and scripted turns: productive rounds never pause, idle rounds without children never pause, the threshold engagement with live children, settlement re-arm and re-pause, exit after sustained productive rounds, and exit on goal completion.
