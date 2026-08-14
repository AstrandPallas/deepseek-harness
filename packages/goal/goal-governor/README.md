# @deepseek-ai/dsh-goal-governor

English | [中文](README.zh.md)

Goal governor: keeps a goal's autonomous rounds quiet while child agents are working, but only after the loop has proven it is spinning idle. Productive rounds are never interrupted.

## What it does

Per session, the plugin tracks two streaks across completed turns:

- **Idle streak** grows when a turn ends with no tool activity. When it reaches `idleRoundThreshold` (default 3) while the session has live child agents, the governor pauses the goal.
- **Productive streak** grows when a turn made tool calls. While governed, `productiveRoundThreshold` (default 2) consecutive productive rounds end governed mode and the plugin steps aside.

While governed, a child settlement notice (`subagent-settled` inbox message) re-arms the goal just long enough for the parent to process the report and launch the next wave. After that turn settles, the governor pauses again while children remain; with no children left it exits governed mode and returns to the ordinary streak tracking. A completed goal also ends governed mode.

## Configuration

```yaml
- id: goal-governor
  name: '@deepseek-ai/dsh-goal-governor'
  config:
    idleRoundThreshold: 3        # idle rounds before governed mode engages
    productiveRoundThreshold: 2  # productive rounds that end governed mode
```

## Model Experience

Indirectly, through the goal service's `goal/change` context messages.

#### KV Cache effect

Governed mode removes the idle rounds that would otherwise repeat while child agents work, so multi-agent waves grow the context more slowly.

## Known Limitations and Deferred Work

- **Child liveness is read from attached sessions** — a child whose session detached without its durable markers is not counted.
- **Engagement requires live children** — an idle loop with no children is left alone, on purpose; the plugin only governs the multi-agent wave pattern.
