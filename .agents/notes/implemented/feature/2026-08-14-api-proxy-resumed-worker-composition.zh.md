# Agent Note: 恢复的子 agent 会话保留其 worker 组合

Status: implemented

[English](2026-08-14-api-proxy-resumed-worker-composition.md) | 中文

## 问题

通过通用宿主路径（经 ApiProxy 的冷恢复，而非由 owner 驱动的继续执行）恢复的、以会话为载体的子 agent，会像普通会话一样被组合：只恢复其日志记录的 preset、宿主默认模型选择，别无其他。只有 header 里的 `delegationDepth` 存活下来，于是子 agent 保留了禁止委派的深度守卫，却重新获得 preset 的编排器 persona 与工具。被恢复的 worker 因此以为自己是主 agent，尝试委派，随即被深度守卫拒绝，模型把这种错误读作自相矛盾。

## 决策

ApiProxy 的冷恢复 setup 在会话 header 带有任一持久子 agent 标记（`origin: 'subagent'` 或正的 `delegationDepth`）时，把该会话视为子 agent。对这类会话，它在组合 preset 之后恢复 worker 身份：

- 每个子 agent 都会获得固定的 `subagent:delegation` 运行时上下文语句（`SUBAGENT_DELEGATION_CONTEXT`，从 `dsh-subagent` 重新导出），声明委派作用域且无法从中扩大。descriptor 出现之前产生的旧子 agent 至少能拿到这条身份语句。
- 有效的可继续 `subagent/descriptor` 还会恢复派发时的 persona（一个遮蔽性的 `deployment:persona` section）与工具过滤（`ctx.tools.restrict`）；解析器现在构建 agent options 时会收到被检查的会话，因此 descriptor 里的 `agentProvider`/`agentModel` 能恢复子 agent 自己的路由。

被围栏的 `origin: 'subagent'` 身份不变：对这些会话的通用恢复仍按子 agent 投递契约以 `agent-busy` 拒绝。本修复服务于未被围栏的旧子 agent，而身份丢失实际正发生在这里。

## 备选方案

**只经由 owner 恢复（现状）。** 拒绝：当子 agent 的 header 没有 origin 标记时，其会话已经可以通过通用路径到达，因此组合在那里也必须是正确的。

**套用一个硬编码的通用 worker persona。** 拒绝：persona 文本属于部署配置；固定的委派语句正是为此存在，而有记录时，descriptor 中的 persona 才是正确来源。

## 后果

被恢复的子 agent 不会再把自己呈现为编排器：带 descriptor 的子 agent 会以 persona、工具作用域与路由回归；旧子 agent 至少知道自己处于委派且作用域固定的状态。宿主解析器的 `agentOptions` 选项现在接收被检查的会话，这是放宽（忽略该参数的调用方不受影响）。

## 验证

`api-proxy-cold.spec.ts` 新增两个用例：旧子 agent（只有深度标记）恢复后获得委派语句与宿主默认路由；可继续子 agent 恢复后获得其 descriptor 的 persona、工具限制与记录的 provider/model。两个包的套件（api-remotes 与 apiproxy，382 个测试）全部通过，宿主构建为绿。
