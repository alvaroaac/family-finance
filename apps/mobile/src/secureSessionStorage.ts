/** Session payloads can exceed Keychain's per-value limit. Commit small, encrypted chunks atomically. */
export type StringStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};
type Manifest = { casaChunks: 1; generation: string; parts: number };
function manifest(value: string | null): Manifest | null {
  if (!value) return null;
  try {
    const m = JSON.parse(value) as Manifest;
    return m.casaChunks === 1 &&
      /^[a-zA-Z0-9-]+$/.test(m.generation) &&
      Number.isInteger(m.parts) &&
      m.parts > 0 &&
      m.parts <= 256
      ? m
      : null;
  } catch {
    return null;
  }
}
export function chunkedSessionStorage(
  storage: StringStorage,
  nonce: () => string,
): StringStorage {
  const keys = (key: string, m: Manifest) =>
    Array.from({ length: m.parts }, (_, i) => `${key}.${m.generation}.${i}`);
  async function discard(key: string, m: Manifest | null) {
    if (m) await Promise.all(keys(key, m).map((k) => storage.removeItem(k)));
  }
  return {
    async getItem(key) {
      const raw = await storage.getItem(key);
      const m = manifest(raw);
      if (!m) return raw;
      const parts = await Promise.all(
        keys(key, m).map((k) => storage.getItem(k)),
      );
      return parts.some((p) => p === null) ? null : parts.join("");
    },
    async setItem(key, value) {
      const old = manifest(await storage.getItem(key));
      const m: Manifest = {
        casaChunks: 1,
        generation: nonce(),
        parts: Math.max(1, Math.ceil(value.length / 512)),
      };
      if (m.parts > 256) throw new Error("Session is too large");
      try {
        for (let i = 0; i < m.parts; i++)
          await storage.setItem(
            keys(key, m)[i]!,
            value.slice(i * 512, (i + 1) * 512),
          );
        await storage.setItem(key, JSON.stringify(m));
      } catch (error) {
        await discard(key, m).catch(() => {});
        throw error;
      }
      await discard(key, old).catch(() => {});
    },
    async removeItem(key) {
      const m = manifest(await storage.getItem(key));
      await storage.removeItem(key);
      await discard(key, m);
    },
  };
}
