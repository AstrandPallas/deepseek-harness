# @deepseek-ai/dsh-tool-repo-map

[English](README.md) | 中文

面向模型的 `repo_map` 工具：由工作区源文件生成的紧凑、带排名的结构地图。按语言提取定义，用个性化 PageRank（按修改时间、焦点路径、被提及标识符与对话文件加权）对引用图排序，并按 token 预算裁剪结果。

## 功能

- 工作区是 git 仓库时用 `git ls-files --cached --others --exclude-standard` 列出文件（天然继承各级 `.gitignore`）；否则回退为目录遍历，只读取根 `.gitignore` 与硬编码跳过项。
- 提取 class/function/type/const 定义（带类前缀的方法、箭头函数、赋值常量、再导出、Markdown 标题、配置键），并为每条定义保留一行源码。
- 定义级排序：文件级 PageRank（带收敛检查）把每个文件的排名沿其逐标识符引用边分发，让单个被高频引用的定义即使来自低排名文件也能浮现。种子权重包括修改时间、`focus` 路径、`mentions` 标识符（另带边乘数）、`chat_files`（另带引用边乘数与定义置顶），以及重要文件（README/LICENSE/Makefile/package.json/pyproject.toml/Cargo.toml/go.mod）。
- 渲染满足 token 预算（`maxTokens`，对前缀和做二分搜索，`gpt-tokenizer` o200k_base）的最大行前缀，并受 `maxOutputChars` 硬上限约束；无定义文件以裸路径形式排在末尾。

## 配置

```yaml
- id: tool-repo-map
  name: '@deepseek-ai/dsh-tool-repo-map'
  config:
    maxFiles: 400        # cap on code files scanned
    maxDefs: 1500        # cap on rendered definitions
    maxTokens: 4000      # token budget for the rendered map
    maxOutputChars: 20000 # hard character ceiling
```

代码块中的注释保持英文以与英文版逐字节一致：`maxFiles` 是扫描的代码文件上限，`maxDefs` 是渲染的定义上限，`maxTokens` 是渲染地图的 token 预算，`maxOutputChars` 是字符硬上限。

工具参数：`focus`（置顶的路径子串）、`mentions`（对话正在讨论的标识符名）、`chat_files`（对话一直在读取的路径）。

## 模型体验

- **Token**, 一条工具结果，至多约 `maxTokens` token（按 o200k_base 编码器估算）与 `maxOutputChars` 字符。
- **KV 缓存 / 上下文**, 只读工作区扫描；重叠执行安全，进程内按文件 mtime 缓存结果。
- **持久性**, 无持久状态；每次调用从当前文件重新推导。

## 已知限制与延后工作

- **正则提取，而非 tree-sitter**, 逐语言正则覆盖了引用图所需场景（类、函数、方法、赋值常量、再导出），但会漏掉 tree-sitter 的更细捕获（参数、结构体字段、枚举成员）。采用 tree-sitter 语法已评估并暂缓：WASM 语法资源与异步初始化会让打包后的运行时更复杂，而定向收益有限。
- **目录遍历回退只读根 `.gitignore`**, git 跟踪路径继承嵌套忽略文件；非仓库回退则不会。
- **o200k_base 是代理编码**, token 预算以消费该地图的模型为目标，属于拟合而非线上契约。
