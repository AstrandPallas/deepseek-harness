# Agent Note: tool-subagent 的结构化输出与重试

Status: implemented

[English](2026-08-13-tool-subagent-structured-retries.md) | 中文

## 问题

子 agent 的 spawn 与 fork 提供方早已携带完整结构化输出运行时（启动请求上的 `outputSchema`、子作用域的 `structured_output` 捕获工具，以及经校验的 `SubagentResult.structured`），但面向模型的工具从未暴露它。另外，前台子任务失败（本地 30B 撞上 `max-tokens` 或出错）只会得到一条出错结果，迫使父级自行察觉、重新决策并手动再委派。

## 决策

- **`output_schema` 参数。** 当绑定提供方声明 `outputSchema` 能力时，工具暴露一个可选的、以 object 为根的 JSON Schema 参数。它转发到 `SubagentStartRequest.outputSchema`（子 agent 服务的 `assertObjectJsonSchema` 在持久边界校验）；当子任务捕获到结构化结果时，工具返回以 JSON 渲染的已校验对象，取代子任务的自由文本。无该能力的提供方省略此参数，绕过 schema 夹带的使用会在执行时被拒绝。
- **`retries` 配置。** 非负 `retries` 配置（默认 0）会在前台委派以可重试原因（`error` 或 `max-tokens`）终止时自动重跑，每次尝试在启动下一次前都会 dispose。后台运行绝不自动重试，其结果稍后收集，再委派由父级负责。达到上限后，出错结果仍会附带最后一次尝试的部分输出。

## 备选方案

**对子任务响应做线级语法约束。** 拒绝：pi-ai SDK 只支持按工具约束采样，不支持请求级 `response_format`；harness 的结构化捕获加上 llama-server 原生的工具调用语法已覆盖本地模型场景。

**重试后台/可继续运行。** 拒绝：持久子任务的继续执行契约在 inbox 接受时即返回；在那里重试会孤儿化子任务，并违背由父级负责再委派的语义。

## 后果

现在可以向 worker 索取机器校验过的 JSON，而一次短暂的本地 worker 失败在父级升级前只多花一次自动重跑。代价：每个有能力实例多一个 schema 参数，前台路径多一个有界重试循环。

## 验证

`tool-subagent.spec.ts` 固定了 output_schema 转发与结构化结果渲染、无能力提供方的参数省略与夹带使用拒绝、`max-tokens` 上重试一次、以及达到上限时保留部分输出；既有 schema 形态测试已按新参数更新。
