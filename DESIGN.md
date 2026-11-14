# Design: providers as a module contribution

## Problem

A provider node must route through `ctx.llm.chat`, because that is the only path
that receives credentials from the host and enforces the grant. `ctx.llm.chat`
takes a `ModelHandle` (`{ provider, model }`) and the host resolves it through a
`ProviderRegistry` built from `z1.config.json`.

So a module that ships 236 provider nodes still cannot *teach the host* about a
provider. Today the user runs `scripts/install-providers.ts` and edits a project
config file. That works, but the provider list is data the module already
carries; making the user duplicate it in every project is a wart.

The other half is already solved the right way: models are **not** stored. A node
asks `ctx.llm.models(provider)` and the host performs `GET {baseURL}/models`
with the credential it holds, caches the answer in memory and enforces the same
`llm` grant as `chat`. Nothing about a provider's catalogue is committed, so no
list can go stale; the only thing left to declare is the connection.

## Proposal

Let a module manifest declare providers, and merge them into the runtime
registry with module provenance.

```json
{
  "schemaVersion": 1,
  "id": "com.z1.providers",
  "providers": [
    {
      "id": "openai",
      "protocol": "openai-completions",
      "envKey": "OPENAI_API_KEY",
      "baseURL": "https://api.openai.com/v1"
    }
  ]
}
```

### Rules

1. `providers[]` is declarative data, not code. `envKey` names a variable; a
   manifest never carries a key value.
2. A provider is only usable after the module is approved. The grant records the
   provider contributions alongside capabilities and services, so
   `module.approve` shows the list and a later manifest edit cannot widen it.
3. Precedence: explicit user config wins over a module contribution wins over
   the SDK defaults (`openai`, `river`). A conflict is reported by id, not
   silently resolved.
4. A module may not redefine a provider that another **approved** module already
   contributed; the first approval wins and the second is reported.
5. Removing or rolling back a module removes its unclaimed providers.

### Where it lands

- `packages/module/src/manifest.ts`: a `providers` array with the same shape as
  `ProviderConfig` in `@z1/provider`, validated at parse time (id pattern, https
  or loopback URL, env var name).
- `packages/module/src/store.ts`: persist the list in the grant.
- `packages/bootstrap/src/runtime.ts`: build `ProviderRegistry` from
  `config.providers`, then approved module contributions, then defaults; the
  registry already routes per request, so nothing else changes.
- `z1 module approve`: print the provider list next to capabilities.
- `SECURITY.md`: a provider contribution is the ability to send prompts and code
  to that base URL. That is why it is grant-scoped, not manifest-scoped.

### Migration

Until this lands, `scripts/install-providers.ts` is the supported path and
`DESIGN.md` is the only place that promises the change. The node code, ports and
catalog do not change: only where the host learns the provider changes.

### Rejected alternatives

- **HTTP from the node.** A worker would need the key, and `ctx.net` deliberately
  has no credential access. It would also duplicate retries, streaming and
  redirect checks that the host already does.
- **A `secret` capability.** Broader than needed: every provider node would be
  able to read any secret it names, instead of the host injecting one key per
  request.
