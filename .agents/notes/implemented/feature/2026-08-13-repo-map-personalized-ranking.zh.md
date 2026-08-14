# Agent Note: 个性化定义级仓库地图

Status: implemented

[English](2026-08-13-repo-map-personalized-ranking.md) | 中文

## 问题

`tool-repo-map` 渲染的是按文件排名、只含顶层正则定义的地图。两个结构性缺口限制了它作为定向辅助的价值：排名粒度为文件级（低排名文件里的关键定义永远不浮现），且地图无视对话（模型实际在用的文件与标识符）；同时每次调用都重新遍历并重读整个工作区。

## 决策

- **文件清单。** git 仓库中用 `git ls-files --cached --others --exclude-standard -z` 提供候选列表（天然继承各级 `.gitignore`），否则回退到目录遍历。
- **定义级排名。** 文件级 PageRank（带收敛检查，Δ < 1e-6，上限 100 轮）把每个文件的排名沿其逐标识符引用边分发进 `path|graphName` 得分表；渲染按该得分全局排序定义，使单个被高频引用的定义无论来自何处都能浮现。方法定义携带类前缀显示名，但保留引用图所键控的裸 `graphName`。
- **个性化。** 种子与边乘数跟随对话：`mentions` 标识符提升定义所在文件并获得 ×10 边乘数；`chat_files` 获得种子提升、×50 引用边乘数与定义置顶；焦点路径按 ×100 置顶；README/LICENSE/Makefile/package.json/pyproject.toml/Cargo.toml/go.mod 置顶。
- **渲染。** 每条定义附带其修剪后的源码行；无定义文件以裸路径排在末尾。token 预算（`maxTokens`，默认 4000，用 `gpt-tokenizer` o200k_base 对前缀和做二分搜索）选取最大的行前缀，并受 `maxOutputChars` 硬上限约束。
- **缓存。** 提取结果按进程缓存，键为工作区根 + 路径，以 mtime 失效（上限 256 项）。

## 备选方案

**tree-sitter 提取。** 暂缓：WASM 语法资源与异步初始化会让打包后的运行时更复杂；正则集现已覆盖引用图所需场景（类、函数、方法、赋值常量、再导出），该限制已记录在包 README。

**按定义的 PageRank 节点。** 拒绝：文件级收敛加事后边分发即可复现 Aider 的 ranked-definitions 输出，而无需把节点数翻倍。

## 后果

对未变工作区的重复调用只需支付文件清单与未变 mtime 的缓存命中。地图对任务（mentions、chat files、focus）与预算（token 拟合）都有响应，代价是一个分词器依赖与每次调用的 PageRank 计算。

## 验证

`map.spec.ts` 固定了经目录回退验证的 gitignore 行为、类前缀方法、箭头/赋值常量提取、源码行渲染、无定义文件的裸路径、focus/mention/chat-file 提升、字符预算截断与 token 预算拟合。在临时 git 仓库上的实测冒烟确认了已跟踪 + 未忽略未跟踪文件的清单，以及 mention 提升下的定义排序。
