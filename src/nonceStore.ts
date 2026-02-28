import { INonceStore } from './types';

interface NonceEntry {
  address: string;
  expiresAt: number;
}

/**
 * Creates a simple in-memory nonce store with TTL-based expiry.
 * Nonces are single-use: consuming a nonce removes it from the store.
 * Expired entries are cleaned up lazily on each operation.
 */
export function createNonceStore(ttlMs: number): INonceStore {
  const store = new Map<string, NonceEntry>();

  function purgeExpired(): void {
    const now = Date.now();
    for (const [nonce, entry] of store.entries()) {
      if (entry.expiresAt <= now) {
        store.delete(nonce);
      }
    }
  }

  return {
    save(nonce: string, address: string): void {
      purgeExpired();
      store.set(nonce, { address, expiresAt: Date.now() + ttlMs });
    },

    consume(nonce: string): string | null {
      purgeExpired();
      const entry = store.get(nonce);
      if (!entry) return null;
      store.delete(nonce);
      return entry.address;
    },
  };
}
