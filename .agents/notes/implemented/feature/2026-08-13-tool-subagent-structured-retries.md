# Agent Note: Structured output and retries on tool-subagent

Status: implemented

English | [中文](2026-08-13-tool-subagent-structured-retries.zh.md)

## Problem

The subagent spawn and fork providers already carried a full structured-output runtime (`outputSchema` on the start request, a child-scoped `structured_output` capture tool, and a validated `SubagentResult.structured`), but the model-facing tool never exposed it. Separately, a failed foreground child (a local 30B hitting `max-tokens` or erroring) was just an errored result, forcing the parent to notice, re-decide, and re-delegate by hand.

## Decision

- **`output_schema` parameter.** The tool exposes an optional object-rooted JSON Schema parameter whenever the bound provider advertises the `outputSchema` capability. It forwards to `SubagentStartRequest.outputSchema` (the subagent service's `assertObjectJsonSchema` validates at the durable boundary); when the child captures a structured result, the tool returns the validated object rendered as JSON instead of the child's free text. Providers without the capability omit the parameter, and a use smuggled past the schema is rejected at execution.
- **`retries` config.** A non-negative `retries` config (default 0) re-runs a failed **foreground** delegation whose stop reason is retryable (`error` or `max-tokens`), disposing each attempt before starting the next. Background runs are never auto-retried, their result is collected later and the parent owns re-delegation. After the cap, the errored result still appends the last attempt's partial output.

## Alternatives considered

**Wire-level grammar for the child's response.** Rejected: pi-ai's SDK supports constrained sampling only per-tool, not as a request-level `response_format`, and the harness's structured capture plus llama-server's native tool-call grammar already cover the local-model case.

**Retry background/continuable runs.** Rejected: the durable-child continuation contract returns at inbox acceptance; retrying there would orphan children and contradict the parent-owned re-delegation semantics.

## Consequences

Workers can now be asked for machine-validated JSON, and a transient local-worker failure costs one automatic re-run before the parent escalates. Cost: one schema parameter per capable instance and a bounded retry loop in the foreground path.

## Verification

`tool-subagent.spec.ts` pins output_schema forwarding plus structured-result rendering, parameter omission and smuggled-use rejection on incapable providers, retry-once on `max-tokens`, and cap exhaustion preserving the partial output; the existing schema-shape tests were updated for the new parameter.
