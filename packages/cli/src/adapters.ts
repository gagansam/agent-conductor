import type { AdapterFactory, WorkerAdapter } from '@agent-conductor/adapter-api';
import type { GlobalConfig } from '@agent-conductor/core';

/**
 * The whole plugin mechanism: a provider names a package, the package exports
 * `createAdapter` (or a default export), and the host imports it. The core
 * only ever sees the resulting instances.
 */
export async function loadAdapters(global: GlobalConfig, only?: string[]): Promise<Record<string, WorkerAdapter>> {
  const out: Record<string, WorkerAdapter> = {};
  for (const [name, provider] of Object.entries(global.providers)) {
    if (only && !only.includes(name)) continue;
    let mod: { createAdapter?: AdapterFactory; default?: AdapterFactory };
    try {
      mod = (await import(provider.adapter)) as typeof mod;
    } catch (e) {
      throw new Error(`provider "${name}": cannot load adapter package "${provider.adapter}": ${(e as Error).message}`);
    }
    const factory = mod.createAdapter ?? mod.default;
    if (typeof factory !== 'function') throw new Error(`provider "${name}": "${provider.adapter}" exports neither createAdapter nor a default factory`);
    out[name] = factory(provider.options);
  }
  return out;
}
