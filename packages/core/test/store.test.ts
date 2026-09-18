import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/store.js';

describe('store', () => {
  it('migrates an empty database and is idempotent on reopen', () => {
    const s = Store.open(':memory:');
    expect(s.latestRun()).toBeUndefined();
    s.close();
  });

  it('shares a provider concurrency limit through leases', () => {
    const s = Store.open(':memory:');
    expect(s.tryAcquireLease('claude', 1, 'w1')).toBe(true);
    expect(s.tryAcquireLease('claude', 1, 'w2')).toBe(false);
    expect(s.tryAcquireLease('codex', 1, 'w3')).toBe(true);
    s.releaseLease('claude', 'w1');
    expect(s.tryAcquireLease('claude', 1, 'w2')).toBe(true);
    s.close();
  });

  it('reaps leases held by dead processes', () => {
    const s = Store.open(':memory:');
    // pid 2^31-2 is not a live process.
    expect(s.tryAcquireLease('claude', 1, 'dead', 2147483646)).toBe(true);
    expect(s.tryAcquireLease('claude', 1, 'alive')).toBe(true);
    s.close();
  });

  it('merges provider state', () => {
    const s = Store.open(':memory:');
    s.setProviderState('claude', { utilization_5h: 0.4, resets_at_5h: '2026-01-01T00:00:00Z' });
    s.setProviderState('claude', { consecutive_failures: 2 });
    const st = s.providerState('claude');
    expect(st.utilization_5h).toBe(0.4);
    expect(st.consecutive_failures).toBe(2);
    expect(s.providerState('codex').consecutive_failures).toBe(0);
    s.close();
  });
});
