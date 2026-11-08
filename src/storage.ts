import { SETTINGS_KEY } from "./settings";
import { MAX_TITLE_LENGTH, MAX_PLOT_LENGTH, MAX_HONBUN_LENGTH } from "../server/limits";

// 型定義
export interface Syosetu {
  id: string;
  title: string;
  pages: number;
  plot: string;
  updatedAt: number;
  deleted?: boolean;
  dirty?: boolean;
}

export interface Chapter {
  id: string;
  syosetuId: string;
  Syosetu_title: string;
  title: string;
  page: number;
  honbun: string;
  updatedAt: number;
  deleted?: boolean;
  dirty?: boolean;
  // Emptying an existing chapter is destructive; this is set only by an
  // explicit editor save so sync can distinguish it from an accidental blank.
  honbunClearRequested?: boolean;
}

const MAX_TITLE = MAX_TITLE_LENGTH;
const MAX_PLOT = MAX_PLOT_LENGTH;
const MAX_HONBUN = MAX_HONBUN_LENGTH;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isSyosetu(value: unknown): value is Syosetu {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.pages === "number" &&
    typeof v.plot === "string" &&
    typeof v.updatedAt === "number"
  );
}

function isChapter(value: unknown): value is Chapter {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.syosetuId === "string" &&
    typeof v.Syosetu_title === "string" &&
    typeof v.title === "string" &&
    typeof v.page === "number" &&
    typeof v.honbun === "string" &&
    typeof v.updatedAt === "number"
  );
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function validateTitle(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} は文字列で指定してください`);
  }
  if (value.length === 0) {
    throw new ValidationError(`${field} は必須です`);
  }
  return truncate(value, MAX_TITLE);
}

function validatePlot(value: string): string {
  if (typeof value !== "string") return "";
  return truncate(value, MAX_PLOT);
}

function validateHonbun(value: string): string {
  if (typeof value !== "string") return "";
  return truncate(value, MAX_HONBUN);
}

interface IndexState {
  syosetuById: Map<string, Syosetu>;
  syosetuByTitle: Map<string, Syosetu>;
  chapterById: Map<string, Chapter>;
  chaptersBySyosetuId: Map<string, Map<string, Chapter>>;
  dirtySyosetuCount: number;
  dirtyChapterCount: number;
}

function createIndex(): IndexState {
  return {
    syosetuById: new Map(),
    syosetuByTitle: new Map(),
    chapterById: new Map(),
    chaptersBySyosetuId: new Map(),
    dirtySyosetuCount: 0,
    dirtyChapterCount: 0,
  };
}

let index: IndexState = createIndex();
let initStarted = false;
const IMPORT_JOURNAL_KEY = "netnoveleditor_import_journal_v1";

interface ImportJournal {
  kind: "netnoveleditor-import";
  previous: [string, string][];
  targetKeys: string[];
}

function recoverPendingImport(): void {
  if (typeof localStorage === "undefined") return;
  const raw = localStorage.getItem(IMPORT_JOURNAL_KEY);
  if (!raw) return;
  const journal = JSON.parse(raw) as ImportJournal;
  // A legacy work may have this title. Never mistake it for a recovery log.
  if (journal?.kind !== "netnoveleditor-import") return;
  if (
    !Array.isArray(journal.previous) ||
    !journal.previous.every(
      (entry) =>
        Array.isArray(entry) && entry.length === 2 && entry.every((v) => typeof v === "string"),
    ) ||
    !Array.isArray(journal.targetKeys) ||
    !journal.targetKeys.every((key) => typeof key === "string") ||
    [...journal.targetKeys, ...journal.previous.map(([key]) => key)].some(
      (key) => key === SETTINGS_KEY || key === IMPORT_JOURNAL_KEY,
    )
  )
    throw new Error("復元前データの読み込みに失敗しました");
  for (const key of new Set([...journal.targetKeys, ...journal.previous.map(([key]) => key)])) {
    localStorage.removeItem(key);
  }
  for (const [key, value] of journal.previous) localStorage.setItem(key, value);
  localStorage.removeItem(IMPORT_JOURNAL_KEY);
}

function rebuildFromStorage(): void {
  recoverPendingImport();
  index = createIndex();
  for (const { record } of storedRecords()) indexRawRecord(record);
}

function* storedRecords(): Generator<{ key: string; raw: string; record: Syosetu | Chapter }> {
  if (typeof localStorage === "undefined") return;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key === SETTINGS_KEY) continue;
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (isSyosetu(parsed) || isChapter(parsed)) yield { key, raw, record: parsed };
  }
}

function indexRawRecord(parsed: Syosetu | Chapter): void {
  if (isSyosetu(parsed)) {
    index.syosetuById.set(parsed.id, parsed);
    index.syosetuByTitle.set(parsed.title, parsed);
    if (parsed.dirty) index.dirtySyosetuCount++;
    return;
  }
  indexChapter(parsed);
}

export function initStorage(): void {
  if (initStarted) return;
  rebuildFromStorage();
  initStarted = true;
}

function ensureInit(): void {
  initStorage();
}

function chapterStorageKey(c: Pick<Chapter, "Syosetu_title" | "page">): string {
  return c.Syosetu_title + "_chapter_" + c.page;
}

function writeSyosetu(s: Syosetu): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(s.title, JSON.stringify(s));
}

function writeChapter(c: Chapter): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(chapterStorageKey(c), JSON.stringify(c));
}

function removeFromStorage(key: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(key);
}

export function setSyosetu(
  input: Omit<Syosetu, "id" | "updatedAt" | "dirty"> & {
    id?: string;
    updatedAt?: number;
    dirty?: boolean;
  },
): Syosetu {
  ensureInit();
  const now = Date.now();
  const title = validateTitle(input.title, "title");
  const plot = validatePlot(input.plot);
  const existing = index.syosetuByTitle.get(title);
  const id = input.id ?? existing?.id ?? newId();
  const prevDirty = existing?.dirty;
  const next: Syosetu = {
    id,
    title,
    pages: input.pages,
    plot,
    updatedAt: input.updatedAt ?? now,
    deleted: input.deleted ?? false,
    dirty: input.dirty ?? true,
  };
  if (existing && existing.title !== next.title) {
    index.syosetuById.delete(existing.id);
    index.syosetuByTitle.delete(existing.title);
    removeFromStorage(existing.title);
    if (prevDirty) index.dirtySyosetuCount--;
  }
  index.syosetuById.set(next.id, next);
  index.syosetuByTitle.set(next.title, next);
  if (prevDirty) index.dirtySyosetuCount--;
  if (next.dirty) index.dirtySyosetuCount++;
  writeSyosetu(next);
  return next;
}

export function getSyosetu(title: string): Syosetu | null {
  ensureInit();
  const s = index.syosetuByTitle.get(title);
  if (s && !s.deleted) return s;
  return null;
}

// Local saves must not inherit synchronization metadata from a loaded record.
// Keep the low-level setters for applying server records with their timestamps.
export function saveSyosetu(input: Parameters<typeof setSyosetu>[0]): Syosetu {
  ensureInit();
  const current = input.id
    ? index.syosetuById.get(input.id)
    : index.syosetuByTitle.get(input.title);
  return setSyosetu({
    ...input,
    updatedAt: Math.max(Date.now(), (current?.updatedAt ?? 0) + 1, (input.updatedAt ?? 0) + 1),
    dirty: true,
  });
}

export function getSyosetuById(id: string): Syosetu | null {
  ensureInit();
  const s = index.syosetuById.get(id);
  if (s && !s.deleted) return s;
  return null;
}

export function listSyosetu(): Syosetu[] {
  ensureInit();
  const result: Syosetu[] = [];
  for (const s of index.syosetuByTitle.values()) {
    if (!s.deleted) result.push(s);
  }
  result.sort((a, b) => a.title.localeCompare(b.title));
  return result;
}

export function listAllSyosetuIncludingDirty(): Syosetu[] {
  ensureInit();
  return Array.from(index.syosetuById.values());
}

export function setChapter(
  input: Omit<Chapter, "id" | "updatedAt" | "dirty" | "syosetuId"> & {
    id?: string;
    syosetuId?: string;
    updatedAt?: number;
    dirty?: boolean;
  },
): Chapter {
  ensureInit();
  const now = Date.now();
  const title = validateTitle(input.title, "title");
  const honbun = validateHonbun(input.honbun);
  const existing =
    (input.id ? index.chapterById.get(input.id) : null) ??
    findChapterBySyosetuAndPage(input.Syosetu_title, input.page);
  const id = input.id ?? existing?.id ?? newId();
  const syosetuId =
    input.syosetuId ?? existing?.syosetuId ?? getSyosetu(input.Syosetu_title)?.id ?? newId();
  const prevDirty = existing?.dirty;
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
    honbunClearRequested: input.honbunClearRequested ?? existing?.honbunClearRequested ?? false,
  };
  if (existing && (existing.syosetuId !== next.syosetuId || existing.page !== next.page)) {
    unindexChapter(existing);
    removeFromStorage(chapterStorageKey(existing));
  } else if (prevDirty) {
    index.dirtyChapterCount--;
  }
  indexChapter(next);
  writeChapter(next);
  return next;
}

function findChapterBySyosetuAndPage(title: string, page: number): Chapter | null {
  for (const c of index.chapterById.values()) {
    if (c.Syosetu_title === title && c.page === page && !c.deleted) return c;
  }
  return null;
}

export function saveChapter(input: Parameters<typeof setChapter>[0]): Chapter {
  ensureInit();
  const current = input.id
    ? index.chapterById.get(input.id)
    : findChapterBySyosetuAndPage(input.Syosetu_title, input.page);
  return setChapter({
    ...input,
    updatedAt: Math.max(Date.now(), (current?.updatedAt ?? 0) + 1, (input.updatedAt ?? 0) + 1),
    dirty: true,
    honbunClearRequested:
      input.honbun === "" &&
      (input.honbunClearRequested === true ||
        current?.honbunClearRequested === true ||
        (current != null && current.honbun !== "")),
  });
}

function unindexChapter(c: Chapter): void {
  index.chapterById.delete(c.id);
  const list = index.chaptersBySyosetuId.get(c.syosetuId);
  if (list) {
    list.delete(c.id);
    if (list.size === 0) index.chaptersBySyosetuId.delete(c.syosetuId);
  }
  if (c.dirty) index.dirtyChapterCount--;
}

function indexChapter(c: Chapter): void {
  index.chapterById.set(c.id, c);
  let list = index.chaptersBySyosetuId.get(c.syosetuId);
  if (!list) {
    list = new Map();
    index.chaptersBySyosetuId.set(c.syosetuId, list);
  }
  list.set(c.id, c);
  if (c.dirty) index.dirtyChapterCount++;
}

// Compare exact revisions, including tombstones, without copying all records.
export function isCurrentRecord(record: Syosetu | Chapter): boolean {
  ensureInit();
  return "syosetuId" in record
    ? index.chapterById.get(record.id) === record
    : index.syosetuById.get(record.id) === record;
}

export function getChapter(Syosetu_title: string, page: number): Chapter | null {
  ensureInit();
  return findChapterBySyosetuAndPage(Syosetu_title, page);
}

export function getChapterById(id: string): Chapter | null {
  ensureInit();
  const c = index.chapterById.get(id);
  if (c && !c.deleted) return c;
  return null;
}

export function deleteChapter(Syosetu_title: string, page: number): void {
  ensureInit();
  const c = getChapter(Syosetu_title, page);
  if (!c) return;
  setChapter({ ...c, deleted: true, updatedAt: Date.now(), dirty: true });
}

export function deleteSyosetu(title: string): void {
  ensureInit();
  const s = getSyosetu(title);
  if (!s) return;

  const now = Date.now();
  setSyosetu({ ...s, deleted: true, updatedAt: now, dirty: true });

  // Keep child tombstones locally so an offline work deletion can be retried
  // and cleaned up only after the dedicated delete request succeeds.
  const chapters = index.chaptersBySyosetuId.get(s.id);
  for (const c of chapters?.values() ?? []) {
    if (c.deleted) continue;
    setChapter({ ...c, deleted: true, updatedAt: now, dirty: true });
  }
}

export function listChapters(Syosetu_title: string): Chapter[] {
  ensureInit();
  const list = index.chaptersBySyosetuId.get(getSyosetu(Syosetu_title)?.id ?? "");
  const result: Chapter[] = [];
  if (list) for (const c of list.values()) if (!c.deleted) result.push(c);
  result.sort((a, b) => a.page - b.page);
  return result;
}

export function listAllChapters(): Chapter[] {
  ensureInit();
  return Array.from(index.chapterById.values());
}

export function listDirtySyosetu(): Syosetu[] {
  ensureInit();
  const result: Syosetu[] = [];
  for (const s of index.syosetuById.values()) {
    if (s.dirty) result.push(s);
  }
  return result;
}

export function listDirtyChapters(): Chapter[] {
  ensureInit();
  const result: Chapter[] = [];
  for (const c of index.chapterById.values()) {
    if (c.dirty) result.push(c);
  }
  return result;
}

export function markSyosetuClean(id: string): void {
  ensureInit();
  const s = index.syosetuById.get(id);
  if (!s) return;
  if (s.dirty) index.dirtySyosetuCount--;
  const clean: Syosetu = { ...s, dirty: false };
  index.syosetuById.set(id, clean);
  index.syosetuByTitle.set(clean.title, clean);
  writeSyosetu(clean);
}

export function markChapterClean(id: string): void {
  ensureInit();
  const c = index.chapterById.get(id);
  if (!c) return;
  if (c.dirty) index.dirtyChapterCount--;
  const clean: Chapter = { ...c, dirty: false, honbunClearRequested: false };
  indexChapter(clean);
  writeChapter(clean);
}

export function removeAcknowledgedTombstones(works: Syosetu[], chapters: Chapter[]): void {
  ensureInit();
  // Only remove the exact versions sent to the server. A new deletion may have
  // happened while a request was in flight and must remain pending.
  for (const s of works) {
    if (s.deleted && index.syosetuById.get(s.id) === s) {
      removeFromStorage(s.title);
      index.syosetuById.delete(s.id);
      if (index.syosetuByTitle.get(s.title) === s) index.syosetuByTitle.delete(s.title);
      if (s.dirty) index.dirtySyosetuCount--;
    }
  }
  for (const c of chapters) {
    if (c.deleted && index.chapterById.get(c.id) === c) {
      removeFromStorage(chapterStorageKey(c));
      unindexChapter(c);
    }
  }
}

export function nextChapterPage(Syosetu_title: string): number {
  ensureInit();
  const list = index.chaptersBySyosetuId.get(getSyosetu(Syosetu_title)?.id ?? "");
  if (!list) return 1;
  let max = 0;
  for (const c of list.values()) if (c.page > max) max = c.page;
  return max + 1;
}

export interface BackupData {
  version: number;
  exportedAt: string;
  works: Syosetu[];
  chapters: Chapter[];
}

function userDataEntries(): [string, string][] {
  const entries: [string, string][] = [];
  for (const { key, raw } of storedRecords()) entries.push([key, raw]);
  return entries;
}

export function exportBackup(): string {
  const works = listSyosetu();
  const chapters: Chapter[] = [];
  for (const w of works) {
    chapters.push(...listChapters(w.title));
  }
  const data: BackupData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    works,
    chapters,
  };
  return JSON.stringify(data);
}

export interface ImportResult {
  works: number;
  chapters: number;
}

export function importBackup(json: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("JSONの解析に失敗しました");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("バックアップの形式が不正です");
  }
  const data = parsed as Partial<BackupData>;
  if (data.version !== 1) {
    throw new Error(`対応していないバージョンです: ${data.version}`);
  }
  const validTimestamp = (value: number) =>
    Number.isSafeInteger(value) && value >= 0 && value < 8_640_000_000_000_000;
  const validTitle = (value: string) => value.trim().length > 0 && value.length <= MAX_TITLE;
  const validFlags = (value: Syosetu | Chapter) =>
    (value.deleted === undefined || value.deleted === false) &&
    (value.dirty === undefined || typeof value.dirty === "boolean");
  if (
    !Array.isArray(data.works) ||
    !Array.isArray(data.chapters) ||
    !data.works.every(
      (w) =>
        isSyosetu(w) &&
        w.id.length > 0 &&
        validTitle(w.title) &&
        Number.isSafeInteger(w.pages) &&
        w.pages >= 0 &&
        w.plot.length <= MAX_PLOT &&
        validTimestamp(w.updatedAt) &&
        validFlags(w),
    ) ||
    !data.chapters.every(
      (c) =>
        isChapter(c) &&
        c.id.length > 0 &&
        validTitle(c.title) &&
        Number.isSafeInteger(c.page) &&
        c.page > 0 &&
        c.honbun.length <= MAX_HONBUN &&
        validTimestamp(c.updatedAt) &&
        validFlags(c) &&
        (c.honbunClearRequested === undefined || typeof c.honbunClearRequested === "boolean"),
    )
  )
    throw new Error("バックアップに不正な作品・話データが含まれています");

  const works = data.works;
  const chapters = data.chapters;
  const workById = new Map(works.map((w) => [w.id, w]));
  if (
    workById.size !== works.length ||
    new Set(chapters.map((c) => c.id)).size !== chapters.length
  ) {
    throw new Error("バックアップ内のIDが重複しています");
  }
  for (const c of chapters) {
    if (workById.get(c.syosetuId)?.title !== c.Syosetu_title) {
      throw new Error("話と作品の紐づけが不正です");
    }
  }

  if (typeof localStorage === "undefined") throw new Error("この環境では復元できません");
  ensureInit();
  if (localStorage.getItem(IMPORT_JOURNAL_KEY) !== null) {
    throw new Error("復元用の保存キーが既存データと衝突しています");
  }
  const previous = userDataEntries();
  const previousKeys = new Set(previous.map(([key]) => key));
  const entries = new Map<string, string>();
  const addEntry = (key: string, value: Syosetu | Chapter) => {
    if (
      key === SETTINGS_KEY ||
      key === IMPORT_JOURNAL_KEY ||
      entries.has(key) ||
      (localStorage.getItem(key) !== null && !previousKeys.has(key))
    ) {
      throw new Error("作品名や話番号が重複、または保存用のキーと衝突しています");
    }
    entries.set(key, JSON.stringify(value));
  };
  const now = Date.now();
  for (const w of works) {
    addEntry(w.title, {
      ...w,
      updatedAt: Math.max(now, w.updatedAt + 1, (index.syosetuById.get(w.id)?.updatedAt ?? 0) + 1),
      deleted: false,
      dirty: true,
    });
  }
  for (const c of chapters) {
    addEntry(chapterStorageKey(c), {
      ...c,
      updatedAt: Math.max(now, c.updatedAt + 1, (index.chapterById.get(c.id)?.updatedAt ?? 0) + 1),
      deleted: false,
      dirty: true,
      honbunClearRequested: c.honbun === "",
    });
  }

  // Persist the rollback data BEFORE removing anything. If quota is exhausted,
  // abort here with the existing data untouched. The journal also survives a
  // tab closing mid-import and is recovered on the next initialization.
  const journal: ImportJournal = {
    kind: "netnoveleditor-import",
    previous,
    targetKeys: Array.from(entries.keys()),
  };
  localStorage.setItem(IMPORT_JOURNAL_KEY, JSON.stringify(journal));
  try {
    for (const [key] of previous) localStorage.removeItem(key);
    for (const [key, value] of entries) localStorage.setItem(key, value);
    localStorage.removeItem(IMPORT_JOURNAL_KEY);
  } catch (err) {
    recoverPendingImport();
    rebuildFromStorage();
    throw err;
  }
  rebuildFromStorage();
  return { works: works.length, chapters: chapters.length };
}

export function pendingPushCount(): number {
  ensureInit();
  return index.dirtySyosetuCount + index.dirtyChapterCount;
}
