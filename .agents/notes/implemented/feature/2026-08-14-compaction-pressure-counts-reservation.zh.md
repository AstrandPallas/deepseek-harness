# Agent Note：压缩压力计入保留的完成额度

Status: implemented

[English](2026-08-14-compaction-pressure-counts-reservation.md) | 中文

## 问题

主动压力阈值曾把 `ctx.tokenMeter.measure()`（提示词 envelope）与 `floor(contextWindow × thresholdRatio)` 比较。提供方会拒绝提示词加 `max_tokens`（保留的完成额度）超出窗口的请求，因此较大的默认保留额度会留下一段死区：提供方先拒绝，harness 还没来得及压缩。以 DeepSeek 适配器默认 `maxTokens: 256000` 与 1,048,576 的提供方窗口为例，有效提示词上限约为 786K，而 `0.8` 阈值要到 800K 才触发：会话可能在没有任何主动压缩的情况下越过提供方上限；若溢出恢复又因无关原因失败，会话就再也无法运行下一轮。

## 决策

压力比较把保留的完成额度加到计量出的提示词上：`measurement.totalTokens + reservation >= thresholdTokens`。reservation 取持久请求头中的有效 `config.maxTokens`（适配器默认值已在那里物化）；在会话首次路由请求之前，回退到所属适配器的 `defaultMaxTokens`；两者都没有时为 `0`，比较保持原行为。提供方确认的溢出路径不变：它不需要 reservation 估算。

## 备选方案

**只用模型目录的 `maxTokens`。** 拒绝：参考性目录在默认路由上省略该字段（DeepSeek 默认模型只声明 `contextWindow`），而请求头已经携带下一次请求实际会使用的值。

**为 reservation 新增配置键。** 拒绝：reservation 是提供方与请求事实，不是部署调优；两个回退来源已是权威值，配置值反而可能与实际构造的请求不一致。

**改为对 `contextWindow − reservation` 取阈值。** 对固定 reservation 等价，但加法形式保持 `resolveCompactSpec` 与其 `thresholdTokens` 不变，保留校验与错误消息仍可比较。

## 后果

只要 reservation 可知，压力压缩现在就发生在提供方上限之前。没有路由请求或适配器不提供 reservation 的会话行为与原先完全一致。[调用后压力笔记](../architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.md)记录触发语义。

## 验证

`compaction-basic.spec.ts` 新增两个用例：持久请求头的 `maxTokens` 单独把提示词加保留额度推过阈值并触发压缩；请求头未记录时，适配器 `defaultMaxTokens` 回退达到同样效果。compaction-basic 套件（124 个测试）与宿主 typecheck 通过。
