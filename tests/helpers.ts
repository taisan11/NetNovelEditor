import * as storage from "../src/storage";

export class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  failWrite: ((key: string, value: string) => boolean) | null = null;
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.failWrite?.(key, value)) throw new DOMException("Storage full", "QuotaExceededError");
    this.values.set(key, String(value));
  }
}

export function resetStorage(): MemoryStorage {
  const memory = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: memory, configurable: true });
  storage.importBackup(JSON.stringify({ version: 1, works: [], chapters: [] }));
  return memory;
}

export function seedRecords() {
  const work = storage.setSyosetu({
    id: "work",
    title: "work",
    pages: 1,
    plot: "original plot",
    updatedAt: 100,
    dirty: false,
  });
  const chapter = storage.setChapter({
    id: "chapter",
    syosetuId: work.id,
    Syosetu_title: work.title,
    title: "chapter",
    page: 1,
    honbun: "original text",
    updatedAt: 100,
    dirty: false,
  });
  return { work, chapter };
}
