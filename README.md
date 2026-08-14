# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Features

This fork ships a few extras on top of the base harness:

- **Cross-provider failover** (`dsh-llm-fallback`): after same-route retries exhaust, a terminal failure can retry once on another provider route. Hops are bounded per step, a route already tried is never revisited, and provider level failures cool the source route down so later requests skip it until it recovers.
- **Declarative role router** (`dsh-llm-router`): ordered rules pick a provider and model by delegation depth and context inheritance. Dormant until a deployment supplies rules.
- **Workspace maps** (`dsh-tool-repo-map`): the `repo_map` tool builds a compact ranked map of the codebase, using git tracked files, per language definitions, and a reference graph personalized by focus paths, mentioned identifiers, and files the conversation has read.
- **Per-provider concurrency caps** (`dsh-llm-pi-ai`): a `maxConcurrent` profile queues streams beyond a route's limit in arrival order. Sized for local servers with a fixed slot count.
- **Structured subagent output and retries** (`dsh-tool-subagent`): `output_schema` returns validated JSON from a worker, and `retries` re-runs foreground runs that stop with `error` or `max-tokens`.
- **Session cost ledger** (`dsh-cost-meter`): a `cost` tool folds logged usage through per-route prices, with an optional per-session budget that fails further requests once exceeded.

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
