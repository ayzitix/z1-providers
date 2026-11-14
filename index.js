/**
 * `com.z1.providers` — one z1 node per models.dev provider.
 *
 * Every node mirrors the `z1.llm.chat` ports, so it can replace that node in a
 * graph; the provider is fixed by the node and the model comes from config.
 * Providers z1 has no transport for are listed as well, so a graph can be built
 * against the real catalog and fails with an explanation at execution time.
 *
 * @module com.z1.providers
 */

export { nodes } from './lib/providers.generated.js'
export { MODULE_ID, NODE_VERSION } from './lib/catalog.js'
