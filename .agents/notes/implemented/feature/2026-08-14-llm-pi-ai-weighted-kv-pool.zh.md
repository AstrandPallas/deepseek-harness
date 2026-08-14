# Agent Note: 共享本地路由的加权 KV 池预算

Status: implemented

[English](2026-08-14-llm-pi-ai-weighted-kv-pool.md) | 中文

## 问题

多条提供方路由可以指向同一台本地服务器（一个具有固定 KV 池的 llama.cpp 进程），但每条路由的 `maxConcurrent` 上限只统计自己的流。针对同一池尺寸的 worker 类别，例如 32K lean 类与 112K deep 类，无法安全共存：上限彼此不可见，deep 请求可能在 lean 请求运行的同时启动并溢出共享池；而全局上限为 1 又会串行化一切，丢掉并行性。

## 决策

`llm-pi-ai` profile 获得加权共享预算。声明 `kvUnits` 与 `kvPool` 的路由（两者必须同时设置、配合显式 `baseURL`，且 `kvUnits <= kvPool`）在容量为 `kvPool` 的共享池中为每个请求预留 `kvUnits` 个许可，以 `baseURL` 为键覆盖所有声明该预算的路由。`Semaphore` 增加加权获取：许可不足时请求排队，发放采用优先队首的首次适配，因此被阻塞的大请求不会挡住放得下的小请求，同类别可放下的请求保持先到先得。中止的等待者仍会离开队列且不占用许可。

未声明 `kvUnits` 的路由保持现有的按路由 `maxConcurrent` 限制不变。

## 备选方案

**跨路由的全局 `maxConcurrent`。** 拒绝：它不按请求大小接纳，deep 请求与多个 lean 请求仍可能共同溢出池；权重才让预算诚实。

**所有等待者严格 FIFO。** 拒绝：排队的 deep 请求会在许可空闲时阻塞队首后的 lean 到达，而这正是 worker 类别布局要避免的饥饿。

## 后果

worker 类别可以安全共享一台服务器：deep 请求等待 lean 与 mid 请求耗尽，新的 lean 请求越过等待中的 deep 请求，池永远不会被超额订阅超过声明的单位数。每个请求的成本仍是一对获取/释放；池注册表多一张以 `baseURL` 为键的表。

## 验证

`semaphore.spec.ts` 固定了跳过阻塞的获取、可放下请求之间的 FIFO、单位校验与容量拒绝；`adapter.spec.ts` 对延迟 mock 服务器驱动两条加权路由，固定 deep 请求等待而第二个 lean 请求先到达服务器。配置解析拒绝缺少 `kvPool` 或 `baseURL` 的 `kvUnits`，以及高于 `kvPool` 的 `kvUnits`。
