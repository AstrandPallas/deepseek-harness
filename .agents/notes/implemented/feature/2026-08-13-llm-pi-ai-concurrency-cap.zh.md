# Agent Note: llm-pi-ai 的按提供方并发上限

Status: implemented

[English](2026-08-13-llm-pi-ai-concurrency-cap.md) | 中文

## 问题

本地推理服务器（llama.cpp 的 `-np 4`）有硬性 slot 数，但没有任何机制约束并发流：同级子 agent、标题与压缩摘要可能同时打到本地路由，溢出 KV 池并让本可由简单排队解决的请求失败。

## 决策

`llm-pi-ai` 增加按提供方的 `maxConcurrent` profile 字段（正整数，可选）。`PiAiAdapter.stream()` 在任何网络或凭据工作之前为该路由获取一个计数信号量，并在流结束时释放，允许量贯穿整条流，包括所有 finally 路径。等待者按到达顺序排队；调用方 signal 中止的等待者会离开队列并以 `ABORTED` 拒绝，且不占用 slot。限制器按路由键控，配置的上限变化时替换；未设置该字段的路由不受限。

## 备选方案

**只在 `tool-subagent` 上做信号量。** 拒绝：子 agent 派发不是唯一的本地模型调用（还有会话标题、压缩摘要），而适配器是每个调用都会经过的唯一咽喉点。

**只靠服务端。** 拒绝：llama-server 本身按 slot 排队，但 harness 侧排队能保住顺序、提供排队中止语义，并快速失败而不是依赖服务器超时。

## 后果

受限路由上同一时刻至多 `maxConcurrent` 条流在跑；其余排队并在 slot 空出时按序启动。代价：受限路由上每条流一对获取/释放，以及每个路由一个限制器条目。

## 验证

`adapter.spec.ts` 用 `maxConcurrent: 1` 对着带延迟的 mock 服务器并发发起两个请求，固定第二个在第一个完成前绝不抵达服务器。`semaphore.spec.ts` 固定按到达顺序排队、排队中止移除且不丢 slot、双重释放幂等，以及 schema 对 `maxConcurrent: 0` 的拒绝。
