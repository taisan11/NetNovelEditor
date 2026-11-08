import { beforeEach, expect, test } from "bun:test"
import * as storage from "../src/storage"
import { SETTINGS_KEY } from "../src/settings"
import { resetStorage, seedRecords } from "./helpers"

beforeEach(resetStorage)

test("local saves advance timestamps and mark synchronized records dirty", () => {
  const { work, chapter } = seedRecords()
  const future = Date.now() + 100_000
  const savedChapter = storage.saveChapter({ ...chapter, updatedAt: future, honbun: "edited" })
  const savedWork = storage.saveSyosetu({ ...work, updatedAt: future, plot: "edited" })
  expect(savedChapter.updatedAt).toBe(future + 1)
  expect(savedWork.updatedAt).toBe(future + 1)
  expect(savedChapter.dirty).toBe(true)
  expect(savedWork.dirty).toBe(true)
  // A stale editor object cannot move the revision backwards.
  expect(storage.saveChapter({ ...chapter, honbun: "edited again" }).updatedAt).toBe(future + 2)
})

test("export/import round trip preserves content and makes it pending", () => {
  const { work, chapter } = seedRecords()
  const result = storage.importBackup(storage.exportBackup())
  expect(result).toEqual({ works: 1, chapters: 1 })
  expect(storage.getSyosetuById(work.id)?.plot).toBe(work.plot)
  expect(storage.getChapterById(chapter.id)?.honbun).toBe(chapter.honbun)
  expect(storage.pendingPushCount()).toBe(2)
})

test("intentional body clearing survives repeated saves until acknowledged", () => {
  const { chapter } = seedRecords()
  const cleared = storage.saveChapter({ ...chapter, honbun: "" })
  expect(cleared.honbunClearRequested).toBe(true)
  expect(storage.saveChapter({ ...cleared, honbun: "" }).honbunClearRequested).toBe(true)
  storage.markChapterClean(chapter.id)
  expect(storage.getChapterById(chapter.id)?.honbunClearRequested).toBe(false)
  expect(storage.saveChapter({ ...cleared, honbun: "new text" }).honbunClearRequested).toBe(false)
})

test("restoring an older backup creates revisions newer than current local data", () => {
  const { work, chapter } = seedRecords()
  const backup = storage.exportBackup()
  const future = Date.now() + 100_000
  storage.setSyosetu({ ...work, plot: "new plot", updatedAt: future })
  storage.setChapter({ ...chapter, honbun: "new text", updatedAt: future })
  storage.importBackup(backup)
  expect(storage.getSyosetuById(work.id)?.updatedAt).toBe(future + 1)
  expect(storage.getChapterById(chapter.id)?.updatedAt).toBe(future + 1)
  expect(storage.getChapterById(chapter.id)?.honbun).toBe(chapter.honbun)
})

test.each([
  "not json", "null", "[]", '{"version":2}', '{"version":1}',
  '{"version":1,"works":[null],"chapters":[]}',
  '{"version":1,"works":[],"chapters":[{}]}',
])("invalid backup leaves all original data untouched: %s", (json) => {
  seedRecords()
  const original = storage.exportBackup()
  const originalKeys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
  expect(() => storage.importBackup(json)).toThrow()
  expect(JSON.parse(storage.exportBackup()).works).toEqual(JSON.parse(original).works)
  expect(JSON.parse(storage.exportBackup()).chapters).toEqual(JSON.parse(original).chapters)
  expect(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))).toEqual(originalKeys)
})

test.each([
  "duplicate work IDs", "duplicate titles", "duplicate chapter IDs", "duplicate pages",
  "missing parent", "wrong parent title", "invalid page", "invalid timestamp", "oversized title", "storage key collision",
])("inconsistent backup is rejected before deleting data: %s", (kind) => {
  const { work, chapter } = seedRecords()
  const works = [{ ...work }]
  const chapters = [{ ...chapter }]
  switch (kind) {
    case "duplicate work IDs": works.push({ ...work, title: "other" }); break
    case "duplicate titles": works.push({ ...work, id: "other" }); break
    case "duplicate chapter IDs": chapters.push({ ...chapter, page: 2 }); break
    case "duplicate pages": chapters.push({ ...chapter, id: "other" }); break
    case "missing parent": chapters[0]!.syosetuId = "missing"; break
    case "wrong parent title": chapters[0]!.Syosetu_title = "wrong"; break
    case "invalid page": chapters[0]!.page = -1; break
    case "invalid timestamp": works[0]!.updatedAt = -1; break
    case "oversized title": chapters[0]!.title = "x".repeat(201); break
    case "storage key collision": works.push({ ...work, id: "other", title: "work_chapter_1" }); break
  }
  expect(() => storage.importBackup(JSON.stringify({ version: 1, works, chapters }))).toThrow()
  expect(storage.getSyosetuById(work.id)).toEqual(work)
  expect(storage.getChapterById(chapter.id)).toEqual(chapter)
  expect(storage.pendingPushCount()).toBe(0)
})

test("backup cannot overwrite settings or other application metadata", () => {
  const { work } = seedRecords()
  localStorage.setItem(SETTINGS_KEY, "settings")
  localStorage.setItem("netnoveleditor_last_sync_v1_account", "200")
  for (const title of [SETTINGS_KEY, "netnoveleditor_last_sync_v1_account", "netnoveleditor_import_journal_v1"]) {
    expect(() => storage.importBackup(JSON.stringify({ version: 1, works: [{ ...work, title }], chapters: [] }))).toThrow()
  }
  expect(localStorage.getItem(SETTINGS_KEY)).toBe("settings")
  expect(localStorage.getItem("netnoveleditor_last_sync_v1_account")).toBe("200")
})

test("failure to stage rollback data does not remove existing records", () => {
  const { work, chapter } = seedRecords()
  const memory = localStorage as ReturnType<typeof resetStorage>
  memory.failWrite = (key) => key === "netnoveleditor_import_journal_v1"
  expect(() => storage.importBackup(storage.exportBackup())).toThrow("Storage full")
  expect(storage.getSyosetuById(work.id)).toEqual(work)
  expect(storage.getChapterById(chapter.id)).toEqual(chapter)
  expect(JSON.parse(localStorage.getItem(work.title)!)).toEqual(work)
})

test("a write failure midway through import rolls back storage and the index", () => {
  const { work, chapter } = seedRecords()
  const memory = localStorage as ReturnType<typeof resetStorage>
  const restoredWork = { ...work, id: "restored-work", title: "restored" }
  const restoredChapter = { ...chapter, id: "restored-chapter", syosetuId: restoredWork.id, Syosetu_title: restoredWork.title }
  memory.failWrite = (key) => key === "restored_chapter_1"
  expect(() => storage.importBackup(JSON.stringify({ version: 1, works: [restoredWork], chapters: [restoredChapter] }))).toThrow("Storage full")
  expect(storage.getSyosetuById(work.id)).toEqual(work)
  expect(storage.getChapterById(chapter.id)).toEqual(chapter)
  expect(JSON.parse(localStorage.getItem(work.title)!)).toEqual(work)
  expect(JSON.parse(localStorage.getItem("work_chapter_1")!)).toEqual(chapter)
  expect(localStorage.getItem(restoredWork.title)).toBeNull()
  expect(localStorage.getItem("netnoveleditor_import_journal_v1")).toBeNull()
})

test("an explicitly empty backup clears works without touching settings", () => {
  seedRecords()
  localStorage.setItem(SETTINGS_KEY, "settings")
  expect(storage.importBackup('{"version":1,"works":[],"chapters":[]}')).toEqual({ works: 0, chapters: 0 })
  expect(storage.listSyosetu()).toEqual([])
  expect(storage.listAllChapters()).toEqual([])
  expect(localStorage.getItem(SETTINGS_KEY)).toBe("settings")
})

test("initialization rolls back an import interrupted by a tab closing", async () => {
  const { work, chapter } = seedRecords()
  const previous: [string, string][] = [
    [work.title, localStorage.getItem(work.title)!],
    ["work_chapter_1", localStorage.getItem("work_chapter_1")!],
  ]
  localStorage.setItem("netnoveleditor_import_journal_v1", JSON.stringify({
    kind: "netnoveleditor-import", previous, targetKeys: ["partially-imported"],
  }))
  localStorage.removeItem(work.title)
  localStorage.removeItem("work_chapter_1")
  localStorage.setItem("partially-imported", JSON.stringify({ ...work, id: "partial", title: "partially-imported" }))
  const recovered = await import("../src/storage.ts?recovery-test")
  recovered.initStorage()
  expect(recovered.getSyosetuById(work.id)).toEqual(work)
  expect(recovered.getChapterById(chapter.id)).toEqual(chapter)
  expect(localStorage.getItem("partially-imported")).toBeNull()
  expect(localStorage.getItem("netnoveleditor_import_journal_v1")).toBeNull()
})

test("a legacy work named after the recovery key is not overwritten", () => {
  const { work } = seedRecords()
  const reserved = storage.setSyosetu({ ...work, id: "reserved", title: "netnoveleditor_import_journal_v1" })
  expect(() => storage.importBackup('{"version":1,"works":[],"chapters":[]}')).toThrow("衝突")
  expect(JSON.parse(localStorage.getItem(reserved.title)!)).toEqual(reserved)
})

test("chapter updates and acknowledgements keep both indexes consistent", () => {
  const { work, chapter } = seedRecords()
  const second = storage.setChapter({ ...chapter, id: "second", page: 3, dirty: false })
  const edited = storage.saveChapter({ ...chapter, honbun: "edited" })
  expect(storage.listChapters(work.title)).toEqual([edited, second])
  expect(storage.pendingPushCount()).toBe(1)
  expect(storage.isCurrentRecord(chapter)).toBe(false)
  expect(storage.isCurrentRecord(edited)).toBe(true)

  storage.markChapterClean(edited.id)
  const clean = storage.getChapterById(edited.id)!
  expect(storage.listChapters(work.title)).toEqual([clean, second])
  expect(clean.dirty).toBe(false)
  expect(storage.pendingPushCount()).toBe(0)
  expect(storage.isCurrentRecord(edited)).toBe(false)
  expect(storage.isCurrentRecord(clean)).toBe(true)
  expect(storage.nextChapterPage(work.title)).toBe(4)
})

test("moving a dirty chapter between works removes its previous index and storage key", () => {
  const { work, chapter } = seedRecords()
  const other = storage.setSyosetu({ title: "other", pages: 0, plot: "", dirty: false })
  const dirty = storage.saveChapter({ ...chapter, honbun: "edited" })
  const moved = storage.setChapter({ ...dirty, syosetuId: other.id, Syosetu_title: other.title, page: 4 })
  expect(storage.listChapters(work.title)).toEqual([])
  expect(storage.listChapters(other.title)).toEqual([moved])
  expect(localStorage.getItem("work_chapter_1")).toBeNull()
  expect(JSON.parse(localStorage.getItem("other_chapter_4")!)).toEqual(moved)
  expect(storage.pendingPushCount()).toBe(1)
  storage.markChapterClean(moved.id)
  expect(storage.pendingPushCount()).toBe(0)
})

test("acknowledged chapter deletion clears its indexes and allows a new first page", () => {
  const { work, chapter } = seedRecords()
  storage.deleteChapter(work.title, chapter.page)
  const tombstone = storage.listDirtyChapters()[0]!
  expect(storage.isCurrentRecord(tombstone)).toBe(true)
  expect(storage.getChapter(work.title, chapter.page)).toBeNull()
  expect(storage.listChapters(work.title)).toEqual([])
  expect(storage.nextChapterPage(work.title)).toBe(2)
  storage.removeAcknowledgedTombstones([], [tombstone])
  expect(storage.listAllChapters()).toEqual([])
  expect(storage.pendingPushCount()).toBe(0)
  expect(storage.nextChapterPage(work.title)).toBe(1)
  expect(storage.isCurrentRecord(tombstone)).toBe(false)
})

test("record identity distinguishes work and chapter IDs even when they match", () => {
  const work = storage.setSyosetu({ id: "shared-id", title: "work", pages: 1, plot: "" })
  const sameId = storage.setChapter({ id: work.id, syosetuId: work.id, Syosetu_title: work.title, title: "chapter", page: 1, honbun: "" })
  expect(storage.isCurrentRecord(work)).toBe(true)
  expect(storage.isCurrentRecord(sameId)).toBe(true)
  storage.saveSyosetu({ ...work, plot: "new" })
  expect(storage.isCurrentRecord(work)).toBe(false)
  expect(storage.isCurrentRecord(sameId)).toBe(true)
})

test("work deletion marks only its own chapters pending", () => {
  const { work, chapter } = seedRecords()
  const other = storage.setSyosetu({ title: "other", pages: 1, plot: "", dirty: false })
  const otherChapter = storage.setChapter({ ...chapter, id: "other-chapter", syosetuId: other.id, Syosetu_title: other.title })
  storage.markChapterClean(otherChapter.id)
  storage.deleteSyosetu(work.title)
  expect(storage.listDirtyChapters().map((c) => c.id)).toEqual([chapter.id])
  expect(storage.listChapters(other.title)).toEqual([storage.getChapterById(otherChapter.id)!])
  expect(storage.getSyosetuById(other.id)?.deleted).toBe(false)
  expect(storage.pendingPushCount()).toBe(2)
})
