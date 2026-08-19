/**
 * deckStore reads localStorage at module load and fires migrateLegacyDeckIds() (which calls
 * fetch) as a side effect of being imported. Both are stubbed here so importing the store in a
 * Node test neither throws nor tries to reach the dev server.
 */
const store = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  },
});

// The migration bails out early when this flag is already set, so it never reaches fetch.
store.set('ptcg-decks-migrated-v1', 'test');

if (!globalThis.fetch) {
  globalThis.fetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
}
