# z1 providers

One z1 node per [models.dev](https://models.dev) provider, plus the catalog the
nodes read and a script that registers a provider with a z1 host.

236 providers, 9135 models. Every provider is a node; a graph picks the provider
by placing the node and the model by its config:

```json
{
  "id": "chat",
  "type": "z1.providers.openai",
  "version": "1.0.0",
  "config": { "model": "gpt-4.1-mini" }
}
```

The ports mirror `z1.llm.chat` (`in`, `messages`, `prompt`, `system`, `tools` →
`text`, `message`, `toolCalls`, `usage`, `hasToolCalls`, `out`), so a provider
node can replace that node without rewiring edges.

## Install

A provider node routes through `ctx.llm.chat`, so the host has to know the
provider's protocol, API root and the environment variable holding the key.
That is one command:

```bash
node scripts/install-providers.ts --file ~/Projects/my-project/z1.config.json --only openai,groq
```

It merges `{ id, protocol, envKey, baseURL }` into `providers[]`, keeps every
other key and every provider it was not asked about, and never reads a key
value — only the variable's name. Use `--all` for every provider whose base URL
is known, `--dry-run` to see the plan.

Then export the key and run:

```bash
export OPENAI_API_KEY=…
z1 run --template agent.loop --message "…" --live --model openai/gpt-4.1-mini
```

Install the module itself the usual way:

```bash
z1 module propose ~/Projects/z1-providers
z1 module approve com.z1.providers
z1 module list
```

## What is supported

| | count | note |
| --- | --- | --- |
| providers | 236 | every models.dev provider is a node |
| OpenAI-compatible | 211 | execute today via `ctx.llm.chat` |
| no known base URL | 13 | the SDK package does not imply a URL; add one to `data/overrides.json` |
| non-OpenAI protocol | 12 | Anthropic, Google, Cohere, Mistral, Bedrock — no transport in z1 yet |

Unsupported providers are nodes on purpose: a graph can be authored against the
real catalog, and the node fails at execution with the reason and a few model
ids. Five supported providers (`cloudflare-workers-ai`, `databricks`,
`infomaniak`, `neon`, `snowflake-cortex`) have an account placeholder in their
base URL; the installer expands `${VAR}` from the environment and skips the
provider when the variable is unset.

## Data

- Source: `https://models.dev/api.json`, the built form of the
  [models.dev repository](https://github.com/anomalyco/models.dev) (MIT).
- `data/catalog.json` is generated, pruned and committed, so a checkout needs no
  network: provider id, name, env, npm package, API root, transport, reason, and
  per model `limit.context`, `cost`, `tool_call`, `reasoning`, `modalities`.
- `data/overrides.json` is hand-maintained: base URLs models.dev does not carry
  (the SDK's own default), each with the `doc` URL it came from.

Regenerate and check:

```bash
node scripts/generate.ts --from-url     # rewrite data, manifest and lib/nodes
node scripts/generate.ts --check        # counts + "regeneration is byte-identical"
node --test "tests/*.test.ts"
```

The generator also accepts `--from-json <file>` for an offline copy.

## Limits

- The module does not touch HTTP itself. Credentials, retries, base URLs and
  redirect checks stay in the host's provider client.
- Node execution requires the provider to be in `z1.config.json`; installing the
  provider from the module manifest is the next change (see `DESIGN.md`).
- `--all` writes 206 providers into one file. For a real project, install the
  handful you use.
- A model id is validated against the catalog at execution time, so a typo names
  the real ids instead of reaching the provider.

## Licence

MIT for this repository; the catalog data is from models.dev under MIT. See
`NOTICE`.
