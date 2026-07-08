import { SETTINGS_KEY } from "./settings"
import {
  MAX_TITLE_LENGTH,
  MAX_PLOT_LENGTH,
  MAX_HONBUN_LENGTH,
} from "../server/limits"

export interface Syosetu {
  id: string
  title: string
  pages: number
  plot: string
  updatedAt: number
  deleted?: boolean
  dirty?: boolean
}

export interface Chapter {
  id: string
  syosetuId: string
  Syosetu_title: string
  title: string
  page: number
  honbun: string
  updatedAt: number
  deleted?: boolean
  dirty?: boolean
}

const MIGRATION_KEY = "netnoveleditor_migration_v2"
const MAX_TITLE = MAX_TITLE_LENGTH
const MAX_PLOT = MAX_PLOT_LENGTH
const MAX_HONBUN = MAX_HONBUN_LENGTH

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ValidationError"
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function isSyosetu(value: unknown): value is Syosetu {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.pages === "number" &&
    typeof v.plot === "string" &&
    typeof v.updatedAt === "number"
  )
}

function isLegacySyosetu(value: unknown): value is Omit<Syosetu, "id" | "updatedAt"> {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.title === "string" &&
    typeof v.pages === "number" &&
    typeof v.plot === "string"
  )
}

function isChapter(value: unknown): value is Chapter {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === "string" &&
    typeof v.syosetuId === "string" &&
    typeof v.Syosetu_title === "string" &&
    typeof v.title === "string" &&
    typeof v.page === "number" &&
    typeof v.honbun === "string" &&
    typeof v.updatedAt === "number"
  )
}

function isLegacyChapter(value: unknown): value is Omit<Chapter, "id" | "syosetuId" | "updatedAt"> {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.Syosetu_title === "string" &&
    typeof v.title === "string" &&
    typeof v.page === "number" &&
    typeof v.honbun === "string"
  )
}

function chapterKey(syosetuTitle: string, page: number): string {
  return `${syosetuTitle}_chapter_${page}`
}

function parseTitleFromChapterKey(key: string): string | null {
  const idx = key.lastIndexOf("_chapter_")
  if (idx <= 0) return null
  return key.slice(0, idx)
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value
}

function validateTitle(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} は文字列で指定してください`)
  }
  if (value.length === 0) {
    throw new ValidationError(`${field} は必須です`)
  }
  return truncate(value, MAX_TITLE)
}

function validatePlot(value: string): string {
  if (typeof value !== "string") return ""
  return truncate(value, MAX_PLOT)
}

function validateHonbun(value: string): string {
  if (typeof value !== "string") return ""
  return truncate(value, MAX_HONBUN)
}

interface IndexState {
  syosetuById: Map<string, Syosetu>
  syosetuByTitle: Map<string, Syosetu>
  chapterById: Map<string, Chapter>
  chaptersBySyosetuId: Map<string, Chapter[]>
  dirtySyosetuCount: number
  dirtyChapterCount: number
}

function createIndex(): IndexState {
  return {
    syosetuById: new Map(),
    syosetuByTitle: new Map(),
    chapterById: new Map(),
    chaptersBySyosetuId: new Map(),
    dirtySyosetuCount: 0,
    dirtyChapterCount: 0,
  }
}

let index: IndexState = createIndex()
let migrationDone = false
let initStarted = false

function rebuildFromStorage(): void {
  index = createIndex()
  if (typeof localStorage === "undefined") return
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key) continue
    if (key === SETTINGS_KEY || key === MIGRATION_KEY) continue
    const raw = localStorage.getItem(key)
    if (!raw) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    indexRawRecord(key, parsed)
  }
}

function indexRawRecord(key: string, parsed: unknown): void {
  if (isSyosetu(parsed)) {
    index.syosetuById.set(parsed.id, parsed)
    index.syosetuByTitle.set(parsed.title, parsed)
    if (parsed.dirty) index.dirtySyosetuCount++
    return
  }
  if (isChapter(parsed)) {
    index.chapterById.set(parsed.id, parsed)
    const list = index.chaptersBySyosetuId.get(parsed.syosetuId) ?? []
    list.push(parsed)
    index.chaptersBySyosetuId.set(parsed.syosetuId, list)
    if (parsed.dirty) index.dirtyChapterCount++
    return
  }
  // Legacy chapter data is not re-indexed here; the migration rewrites
  // it as proper Chapter objects into localStorage on init.
  void key
}

function migrateIfNeeded(): void {
  if (typeof localStorage === "undefined") {
    migrationDone = true
    return
  }
  if (localStorage.getItem(MIGRATION_KEY)) {
    migrationDone = true
    return
  }

  const now = Date.now()
  const allKeys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k) allKeys.push(k)
  }
  const titleToId = new Map<string, string>()

  for (const key of allKeys) {
    if (key === SETTINGS_KEY || key === MIGRATION_KEY) continue
    const raw = localStorage.getItem(key)
    if (!raw) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (isSyosetu(parsed)) {
      titleToId.set(parsed.title, parsed.id)
      continue
    }
    if (isLegacySyosetu(parsed) && !key.includes("_chapter_")) {
      const id = newId()
      const migrated: Syosetu = {
        id,
        title: parsed.title,
        pages: parsed.pages,
        plot: parsed.plot,
        updatedAt: now,
        dirty: true,
      }
      localStorage.setItem(parsed.title, JSON.stringify(migrated))
      localStorage.removeItem(key)
      titleToId.set(parsed.title, id)
    }
  }

  for (const key of allKeys) {
    if (key === SETTINGS_KEY || key === MIGRATION_KEY) continue
    if (!key.includes("_chapter_")) continue
    const raw = localStorage.getItem(key)
    if (!raw) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (isChapter(parsed)) continue
    if (!isLegacyChapter(parsed)) continue
    const parentId = titleToId.get(parsed.Syosetu_title) ?? newId()
    const id = newId()
    const migrated: Chapter = {
      id,
      syosetuId: parentId,
      Syosetu_title: parsed.Syosetu_title,
      title: parsed.title,
      page: parsed.page,
      honbun: parsed.honbun,
      updatedAt: now,
      dirty: true,
    }
    localStorage.setItem(chapterKey(parsed.Syosetu_title, parsed.page), JSON.stringify(migrated))
  }

  localStorage.setItem(MIGRATION_KEY, String(now))
  migrationDone = true
}

export function initStorage(): void {
  if (initStarted) return
  initStarted = true
  migrateIfNeeded()
  rebuildFromStorage()
}

function ensureInit(): void {
  if (initStarted) return
  initStarted = true
  if (!migrationDone) migrateIfNeeded()
  rebuildFromStorage()
}

function writeSyosetu(s: Syosetu): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(s.title, JSON.stringify(s))
}

function writeChapter(c: Chapter): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(c.Syosetu_title + "_chapter_" + c.page, JSON.stringify(c))
}

function removeFromStorage(key: string): void {
  if (typeof localStorage === "undefined") return
  localStorage.removeItem(key)
}

export function setSyosetu(
  input: Omit<Syosetu, "id" | "updatedAt" | "dirty"> & {
    id?: string
    updatedAt?: number
    dirty?: boolean
  },
): Syosetu {
  ensureInit()
  const now = Date.now()
  const title = validateTitle(input.title, "title")
  const plot = validatePlot(input.plot)
  const existing = index.syosetuByTitle.get(title)
  const id = input.id ?? existing?.id ?? newId()
  const prevDirty = existing?.dirty
  const next: Syosetu = {
    id,
    title,
    pages: input.pages,
    plot,
    updatedAt: input.updatedAt ?? now,
    deleted: input.deleted ?? false,
    dirty: input.dirty ?? true,
  }
  if (existing && existing.title !== next.title) {
    index.syosetuById.delete(existing.id)
    index.syosetuByTitle.delete(existing.title)
    removeFromStorage(existing.title)
    if (prevDirty) index.dirtySyosetuCount--
  }
  index.syosetuById.set(next.id, next)
  index.syosetuByTitle.set(next.title, next)
  if (prevDirty) index.dirtySyosetuCount--
  if (next.dirty) index.dirtySyosetuCount++
  writeSyosetu(next)
  return next
}

export function getSyosetu(title: string): Syosetu | null {
  ensureInit()
  const s = index.syosetuByTitle.get(title)
  if (s && !s.deleted) return s
  return null
}

export function getSyosetuById(id: string): Syosetu | null {
  ensureInit()
  const s = index.syosetuById.get(id)
  if (s && !s.deleted) return s
  return null
}

export function listSyosetu(): Syosetu[] {
  ensureInit()
  const result: Syosetu[] = []
  for (const s of index.syosetuByTitle.values()) {
    if (!s.deleted) result.push(s)
  }
  result.sort((a, b) => a.title.localeCompare(b.title))
  return result
}

export function listAllSyosetuIncludingDirty(): Syosetu[] {
  ensureInit()
  return Array.from(index.syosetuById.values())
}

export function setChapter(
  input: Omit<Chapter, "id" | "updatedAt" | "dirty" | "syosetuId"> & {
    id?: string
    syosetuId?: string
    updatedAt?: number
    dirty?: boolean
  },
): Chapter {
  ensureInit()
  const now = Date.now()
  const title = validateTitle(input.title, "title")
  const honbun = validateHonbun(input.honbun)
  const existing =
    (input.id ? index.chapterById.get(input.id) : null) ??
    findChapterBySyosetuAndPage(input.Syosetu_title, input.page)
  const id = input.id ?? existing?.id ?? newId()
  const syosetuId =
    input.syosetuId ?? existing?.syosetuId ?? getSyosetu(input.Syosetu_title)?.id ?? newId()
  const prevDirty = existing?.dirty
  const next: Chapter = {
    id,
    syosetuId,
    Syosetu_title: input.Syosetu_title,
    title,
    page: input.page,
    honbun,
    updatedAt: input.updatedAt ?? now,
    deleted: input.deleted ?? false,
    dirty: input.dirty ?? true,
  }
  if (existing && (existing.syosetuId !== next.syosetuId || existing.page !== next.page)) {
    unindexChapter(existing)
  }
  index.chapterById.set(next.id, next)
  const list = index.chaptersBySyosetuId.get(next.syosetuId) ?? []
  const filtered = list.filter((c) => c.id !== next.id)
  filtered.push(next)
  index.chaptersBySyosetuId.set(next.syosetuId, filtered)
  if (prevDirty) index.dirtyChapterCount--
  if (next.dirty) index.dirtyChapterCount++
  writeChapter(next)
  return next
}

function findChapterBySyosetuAndPage(title: string, page: number): Chapter | null {
  for (const c of index.chapterById.values()) {
    if (c.Syosetu_title === title && c.page === page && !c.deleted) return c
  }
  return null
}

function unindexChapter(c: Chapter): void {
  index.chapterById.delete(c.id)
  const list = index.chaptersBySyosetuId.get(c.syosetuId)
  if (list) {
    index.chaptersBySyosetuId.set(
      c.syosetuId,
      list.filter((x) => x.id !== c.id),
    )
  }
  if (c.dirty) index.dirtyChapterCount--
}

export function getChapter(Syosetu_title: string, page: number): Chapter | null {
  ensureInit()
  for (const c of index.chapterById.values()) {
    if (c.Syosetu_title === Syosetu_title && c.page === page && !c.deleted) return c
  }
  return null
}

export function getChapterById(id: string): Chapter | null {
  ensureInit()
  const c = index.chapterById.get(id)
  if (c && !c.deleted) return c
  return null
}

export function deleteChapter(Syosetu_title: string, page: number): void {
  ensureInit()
  const c = getChapter(Syosetu_title, page)
  if (!c) return
  const now = Date.now()
  const tombstone: Chapter = {
    ...c,
    deleted: true,
    updatedAt: now,
    dirty: true,
  }
  unindexChapter(c)
  index.chapterById.set(tombstone.id, tombstone)
  const list = index.chaptersBySyosetuId.get(tombstone.syosetuId) ?? []
  list.push(tombstone)
  index.chaptersBySyosetuId.set(tombstone.syosetuId, list)
  if (!c.dirty) index.dirtyChapterCount++
  writeChapter(tombstone)
}

export function deleteSyosetu(title: string): void {
  ensureInit()
  const s = index.syosetuByTitle.get(title)
  if (!s) return
  const now = Date.now()
  const chapters = listChapters(title)
  for (const c of chapters) {
    deleteChapter(title, c.page)
  }
  const tombstone: Syosetu = {
    ...s,
    deleted: true,
    updatedAt: now,
    dirty: true,
  }
  index.syosetuById.set(s.id, tombstone)
  index.syosetuByTitle.set(title, tombstone)
  if (!s.dirty) index.dirtySyosetuCount++
  writeSyosetu(tombstone)
}

export function listChapters(Syosetu_title: string): Chapter[] {
  ensureInit()
  const list = index.chaptersBySyosetuId.get(
    getSyosetu(Syosetu_title)?.id ?? "",
  ) ?? []
  const result = list.filter((c) => !c.deleted)
  result.sort((a, b) => a.page - b.page)
  return result
}

export function listAllChapters(): Chapter[] {
  ensureInit()
  return Array.from(index.chapterById.values())
}

export function listDirtySyosetu(): Syosetu[] {
  ensureInit()
  const result: Syosetu[] = []
  for (const s of index.syosetuById.values()) {
    if (s.dirty) result.push(s)
  }
  return result
}

export function listDirtyChapters(): Chapter[] {
  ensureInit()
  const result: Chapter[] = []
  for (const c of index.chapterById.values()) {
    if (c.dirty) result.push(c)
  }
  return result
}

export function markSyosetuClean(id: string): void {
  ensureInit()
  const s = index.syosetuById.get(id)
  if (!s) return
  if (s.dirty) index.dirtySyosetuCount--
  const clean: Syosetu = { ...s, dirty: false }
  index.syosetuById.set(id, clean)
  index.syosetuByTitle.set(clean.title, clean)
  writeSyosetu(clean)
}

export function markChapterClean(id: string): void {
  ensureInit()
  const c = index.chapterById.get(id)
  if (!c) return
  if (c.dirty) index.dirtyChapterCount--
  const clean: Chapter = { ...c, dirty: false }
  index.chapterById.set(id, clean)
  const list = index.chaptersBySyosetuId.get(clean.syosetuId) ?? []
  index.chaptersBySyosetuId.set(
    clean.syosetuId,
    list.map((x) => (x.id === id ? clean : x)),
  )
  writeChapter(clean)
}

export function removeDeletedTombstones(): void {
  ensureInit()
  if (typeof localStorage === "undefined") return
  const toRemove: string[] = []
  for (const s of index.syosetuById.values()) {
    if (s.deleted) toRemove.push(s.title)
  }
  for (const c of index.chapterById.values()) {
    if (c.deleted) toRemove.push(chapterKey(c.Syosetu_title, c.page))
  }
  for (const key of toRemove) removeFromStorage(key)
  rebuildFromStorage()
}

export function nextChapterPage(Syosetu_title: string): number {
  ensureInit()
  const list = index.chaptersBySyosetuId.get(getSyosetu(Syosetu_title)?.id ?? "") ?? []
  if (list.length === 0) return 1
  let max = 0
  for (const c of list) if (c.page > max) max = c.page
  return max + 1
}

export interface BackupData {
  version: number
  exportedAt: string
  works: Syosetu[]
  chapters: Chapter[]
}

function clearUserData(): void {
  if (typeof localStorage === "undefined") return
  const toRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key) continue
    if (key === SETTINGS_KEY || key === MIGRATION_KEY) continue
    const raw = localStorage.getItem(key)
    if (!raw) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    if (isSyosetu(parsed) || isChapter(parsed)) {
      toRemove.push(key)
    }
  }
  for (const key of toRemove) removeFromStorage(key)
}

export function exportBackup(): string {
  const works = listSyosetu()
  const chapters: Chapter[] = []
  for (const w of works) {
    chapters.push(...listChapters(w.title))
  }
  const data: BackupData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    works,
    chapters,
  }
  return JSON.stringify(data)
}

export interface ImportResult {
  works: number
  chapters: number
}

export function importBackup(json: string): ImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error("JSONの解析に失敗しました")
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("バックアップの形式が不正です")
  }
  const data = parsed as Partial<BackupData>
  if (data.version !== 1) {
    throw new Error(`対応していないバージョンです: ${data.version}`)
  }
  const works: Syosetu[] = Array.isArray(data.works) ? data.works.filter(isSyosetu) : []
  const chapters: Chapter[] = Array.isArray(data.chapters)
    ? data.chapters.filter(isChapter)
    : []
  clearUserData()
  for (const w of works) {
    writeSyosetu({ ...w, title: truncate(w.title, MAX_TITLE), plot: truncate(w.plot, MAX_PLOT) })
  }
  for (const c of chapters) {
    writeChapter({
      ...c,
      title: truncate(c.title, MAX_TITLE),
      honbun: truncate(c.honbun, MAX_HONBUN),
    })
  }
  rebuildFromStorage()
  return { works: works.length, chapters: chapters.length }
}

export function pendingPushCount(): number {
  ensureInit()
  return index.dirtySyosetuCount + index.dirtyChapterCount
}

export { parseTitleFromChapterKey }
