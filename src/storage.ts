export interface Syosetu {
  title: string;
  pages: number;
  plot: string;
}

export interface Chapter {
  Syosetu_title: string;
  title: string;
  page: number;
  honbun: string;
}

export function setSyosetu(Syosetu: Syosetu): void {
  localStorage.setItem(Syosetu.title, JSON.stringify(Syosetu));
}

export function getSyosetu(title: string): Syosetu | null {
  const data = localStorage.getItem(title);
  if (data) {
    return JSON.parse(data) as Syosetu;
  }
  return null;
}

export function listSyosetu(): Syosetu[] {
  const result: Syosetu[] = [];
  const keys = Object.keys(localStorage);
  for (const key of keys) {
    if (key.includes("_chapter_")) continue;
    const data = localStorage.getItem(key);
    if (!data) continue;
    try {
      const syosetu = JSON.parse(data) as Syosetu;
      if (typeof syosetu.title === "string" && typeof syosetu.pages === "number") {
        result.push(syosetu);
      }
    } catch (e) {
      console.error(`Error parsing data for key ${key}:`, e);
    }
  }
  result.sort((a, b) => a.title.localeCompare(b.title));
  return result;
}

export function setChapter(chapter: Chapter): void {
  const key = `${chapter.Syosetu_title}_chapter_${chapter.page}`;
  localStorage.setItem(key, JSON.stringify(chapter));
}

export function deleteChapter(Syosetu_title: string, page: number): void {
  const key = `${Syosetu_title}_chapter_${page}`;
  localStorage.removeItem(key);
}

export function getChapter(Syosetu_title: string, page: number): Chapter | null {
  const key = `${Syosetu_title}_chapter_${page}`;
  const data = localStorage.getItem(key);
  if (data) {
    return JSON.parse(data) as Chapter;
  }
  return null;
}

export function listChapters(Syosetu_title: string): Chapter[] {
  const chapters: Chapter[] = [];
  const keys = Object.keys(localStorage);
  for (const key of keys) {
    if (!key.startsWith(`${Syosetu_title}_chapter_`)) continue;
    const data = localStorage.getItem(key);
    if (!data) continue;
    try {
      const chapter = JSON.parse(data) as Chapter;
      if (
        typeof chapter.Syosetu_title === "string" &&
        typeof chapter.title === "string" &&
        typeof chapter.page === "number"
      ) {
        chapters.push(chapter);
      }
    } catch (e) {
      console.error(`Error parsing data for key ${key}:`, e);
    }
  }
  chapters.sort((a, b) => a.page - b.page);
  return chapters;
}

export function nextChapterPage(Syosetu_title: string): number {
  const chapters = listChapters(Syosetu_title);
  if (chapters.length === 0) return 1;
  return Math.max(...chapters.map((c) => c.page)) + 1;
}

export interface BackupData {
  version: number;
  exportedAt: string;
  works: Syosetu[];
  chapters: Chapter[];
}

const SETTINGS_KEY = "netnoveleditor_settings_v1";

function isSyosetu(value: unknown): value is Syosetu {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Syosetu).title === "string" &&
    typeof (value as Syosetu).pages === "number"
  );
}

function isChapter(value: unknown): value is Chapter {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Chapter).Syosetu_title === "string" &&
    typeof (value as Chapter).title === "string" &&
    typeof (value as Chapter).page === "number"
  );
}

function clearUserData(): void {
  const keys = Object.keys(localStorage);
  for (const key of keys) {
    if (key === SETTINGS_KEY) continue;
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isSyosetu(parsed) || isChapter(parsed)) {
        localStorage.removeItem(key);
      }
    } catch {
      // Skip non-JSON values
    }
  }
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
  const works: Syosetu[] = Array.isArray(data.works) ? data.works.filter(isSyosetu) : [];
  const chapters: Chapter[] = Array.isArray(data.chapters) ? data.chapters.filter(isChapter) : [];
  clearUserData();
  for (const w of works) {
    setSyosetu(w);
  }
  for (const c of chapters) {
    setChapter(c);
  }
  return { works: works.length, chapters: chapters.length };
}
