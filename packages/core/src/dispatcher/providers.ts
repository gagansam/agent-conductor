import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CapabilitySet, Detection, WorkerAdapter } from '@agent-conductor/adapter-api';
import type { Paths } from '../config/load.js';
import type { GlobalConfig, ProviderConfig } from '../config/schema.js';
import type { Store } from '../store/store.js';

export interface ProviderRuntime {
  name: string;
  config: ProviderConfig;
  adapter: WorkerAdapter;
  detection: Detection;
  caps: CapabilitySet;
}

export class ProviderError extends Error {
  constructor(readonly provider: string, message: string) {
    super(`provider "${provider}": ${message}`);
    this.name = 'ProviderError';
  }
}

/**
 * Detect each needed provider's CLI and probe its capabilities. Capabilities
 * are cached per (binary, version, mtime): a CLI upgrade re-probes on its own.
 * The host supplies the adapter instances; the core never imports one by name.
 */
export async function prepareProviders(
  global: GlobalConfig,
  adapters: Record<string, WorkerAdapter>,
  store: Store,
  paths: Paths,
  needed: string[],
): Promise<Map<string, ProviderRuntime>> {
  const out = new Map<string, ProviderRuntime>();
  for (const name of new Set(needed)) {
    const config = global.providers[name];
    const adapter = adapters[name];
    if (!config) throw new ProviderError(name, 'not defined in config.providers');
    if (!adapter) throw new ProviderError(name, `no adapter instance was supplied (config names "${config.adapter}")`);
    const vendorHome = join(paths.vendor, name);
    mkdirSync(vendorHome, { recursive: true });
    const detection = await adapter.detect({ ...(config.binary ? { binary: config.binary } : {}), vendorHome });
    const fatal = detection.problems.filter((p) => p.fatal);
    if (fatal.length) throw new ProviderError(name, fatal.map((p) => `${p.code}: ${p.message}`).join('; '));
    const key = { adapter: adapter.id, binary_path: detection.binary_abs, version: detection.version, binary_mtime_ms: Math.trunc(detection.binary_mtime_ms) };
    let caps = store.cachedCapabilities(key);
    if (!caps) {
      caps = await adapter.capabilities(detection);
      store.cacheCapabilities(key, caps);
    }
    out.set(name, { name, config, adapter, detection, caps });
  }
  return out;
}
