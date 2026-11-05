import { beforeEach, expect, mock, test } from "bun:test"
import * as storage from "../src/storage"
import { downloadSync, uploadSync } from "../src/sync"

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return Array.from(this.values.keys())[index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, String(value)) }
}

// Storage keeps an in-memory index, so use unique IDs and titles in each test.
beforeEach(() => {
  if (!globalThis.localStorage) Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage() })
})

test("an edit made during upload stays dirty", async () => {
  const work = storage.setSyosetu({ id: "race-work", title: "race-work", pages: 0, plot: "old", updatedAt: 1 })
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async () => {
    storage.setSyosetu({ ...work, plot: "new", updatedAt: 2 })
    return Response.json({ ok: true, results: { syosetu: [{ id: work.id, winner: "client" }], chapters: [] } })
  }) as typeof fetch
  try {
    await uploadSync()
    expect(storage.getSyosetu(work.title)?.plot).toBe("new")
    expect(storage.getSyosetu(work.title)?.dirty).toBe(true)
  } finally { globalThis.fetch = originalFetch }
})

test("deletions created during upload are not discarded", async () => {
  const work = storage.setSyosetu({ id: "delete-work", title: "delete-work", pages: 0, plot: "", updatedAt: 10 })
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async () => {
    storage.deleteSyosetu(work.title)
    return Response.json({ ok: true, results: { syosetu: [{ id: work.id, winner: "client" }], chapters: [] } })
  }) as typeof fetch
  try {
    await uploadSync()
    expect(storage.listDirtySyosetu().some((s) => s.id === work.id && s.deleted)).toBe(true)
  } finally { globalThis.fetch = originalFetch }
})

test("download requests a full snapshot and preserves newer local deletion", async () => {
  const work = storage.setSyosetu({ id: "pull-work", title: "pull-work", pages: 0, plot: "", updatedAt: 10 })
  storage.deleteSyosetu(work.title)
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("/api/sync/snapshot")
    return Response.json({ serverTime: Date.now(), syosetu: [{ ...work, createdAt: 1, deleted: true }], chapters: [] })
  }) as typeof fetch
  try {
    await downloadSync()
    expect(storage.listDirtySyosetu().some((s) => s.id === work.id && s.deleted)).toBe(true)
  } finally { globalThis.fetch = originalFetch }
})

test("deleting an already dirty chapter retains its pending count", () => {
  const work = storage.setSyosetu({ id: "count-work", title: "count-work", pages: 1, plot: "" })
  storage.setChapter({ id: "count-chapter", syosetuId: work.id, Syosetu_title: work.title, title: "chapter", page: 1, honbun: "text" })
  const before = storage.pendingPushCount()
  storage.deleteChapter(work.title, 1)
  expect(storage.pendingPushCount()).toBe(before)
})
