# z1 providers

One z1 node per [models.dev](https://models.dev) provider, plus the connection
catalog the nodes read and a script that registers a provider with a z1 host.

236 providers. The repository stores **how to connect**, not what a provider
serves: model ids are discovered live (`GET {baseURL}/models`) and cached in
memory for five minutes. A graph picks the provider by placing the node and,
optionally, pins the model:

```json
{
  "id": "chat",
  "type": "z1.providers.openai",
  "version": "1.0.0",
  "config": { "model": "gpt-4.1-mini" }
}
```

`config.model` is optional. Without it the node asks the provider what it has,
uses the first id and logs a warning telling you to pin one. With it, no lookup
happens at all.

```bash
node scripts/models.ts openai --config ./z1.config.json
node scripts/models.ts --all --json
```

Discovery lives in this module, not in the z1 SDK. The SDK knows a base URL and a
credential and offers one primitive — an authenticated `GET` with a path and a
query. Which path (`/models`, `/api/tags`, `/openai/models`), which query
(`?api-version`, `?type=text`) and how to read the body are provider knowledge,
and they live in `lib/models.js` plus the hand-maintained
`data/models-endpoints.json`.

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
real list, and the node fails at execution with the reason. Five supported
providers (`cloudflare-workers-ai`, `databricks`, `infomaniak`, `neon`,
`snowflake-cortex`) have an account placeholder in their base URL; the installer
expands `${VAR}` from the environment and skips the provider when the variable is
unset.

## Model discovery

`ctx.llm.get({ provider, path, query })` is the only host capability involved:
the host appends the path to the provider's base URL, injects the credential,
applies the retry policy and returns the raw body. It is GET-only — a model turn
must go through `ctx.llm.chat` so it is journaled — and the path cannot leave the
configured base URL.

Everything above that is this module:

- `lib/models.js` asks `<path>`, parses `{data:[{id}]}`, `{models:[{name}]}`, a
  bare array or `{result:[…]}`, and dedupes ids in the provider's order;
- `data/models-endpoints.json` overrides the address per provider. It is empty
  today because all 211 supported providers answer `/models`; an exception is a
  data edit, not an SDK change;
- a non-2xx answer becomes "provider answered 404 for GET /models — set
  config.model explicitly", not a silent empty list.

The list is never written to disk and never merged into `data/catalog.json`. A
model id the provider no longer serves produces an error enriched with the ids it
does serve, fetched at the moment it matters.

Why discovery instead of a copied catalogue: `/models` is the only source that is
true when a run happens. Providers add and retire ids weekly, and a committed
list goes stale silently. The trade-off is one request per provider per five
minutes; a pinned `config.model` avoids even that.

## Data

- Source: `https://models.dev/api.json`, the built form of the
  [models.dev repository](https://github.com/anomalyco/models.dev) (MIT). Only
  the connection fields are taken from it, so `data/catalog.json` is 76 KB
  rather than megabytes of model metadata.
- `data/catalog.json` is generated, pruned and committed: provider id, name,
  env, npm package, API root, transport and the reason it is unsupported. No
  models, no prices, no context windows.
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
- Discovery costs one authenticated request per discovery; a provider without a
  catalog endpoint needs an explicit `config.model`.
- A discovered list is ids only. Context windows, pricing and capabilities are
  provider extensions, not part of the OpenAI `/models` contract, so this module
  does not pretend to know them.

## Licence

MIT for this repository; the catalog data is from models.dev under MIT. See
`NOTICE`.
