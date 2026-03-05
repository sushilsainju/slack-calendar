interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class LRUCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  constructor(private maxSize: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Move to end (most-recently-used)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (this.store.size >= this.maxSize) {
      // Evict least-recently-used (first entry)
      this.store.delete(this.store.keys().next().value!);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const rosterCache = new LRUCache<any[]>(50);   // keyed: roster:main
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const statusCache = new LRUCache<any>(5000);   // keyed: status:{slackUserId}:{dateStr}
