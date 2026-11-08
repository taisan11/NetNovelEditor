import { isSettingsRecord, type Settings, type SettingsRecord, type Theme } from "../shared/settings";
export type { Settings, SettingsRecord, Theme } from "../shared/settings";

export const SETTINGS_KEY = "netnoveleditor_settings_v1";
const ACK_KEY = "netnoveleditor_settings_ack_v1_";
const listeners = new Set<(settings: Settings) => void>();

const DEFAULT_SETTINGS: Settings = {
  fontSize: 16,
  lineHeight: 1.7,
  theme: "light",
  verticalWriting: false,
};

const VALID_THEMES: Theme[] = ["light", "dark", "sepia"];

export function getSettings(): Settings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS };
  const data = localStorage.getItem(SETTINGS_KEY);
  if (!data) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(data) as Partial<Settings>;
    return {
      fontSize:
        typeof parsed.fontSize === "number" && parsed.fontSize >= 10 && parsed.fontSize <= 32
          ? Math.max(16, parsed.fontSize)
          : DEFAULT_SETTINGS.fontSize,
      lineHeight:
        typeof parsed.lineHeight === "number" &&
        parsed.lineHeight >= 1.0 &&
        parsed.lineHeight <= 3.0
          ? parsed.lineHeight
          : DEFAULT_SETTINGS.lineHeight,
      theme: VALID_THEMES.includes(parsed.theme as Theme)
        ? (parsed.theme as Theme)
        : DEFAULT_SETTINGS.theme,
      verticalWriting:
        typeof parsed.verticalWriting === "boolean"
          ? parsed.verticalWriting
          : DEFAULT_SETTINGS.verticalWriting,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setSettings(settings: Settings): void {
  if (typeof localStorage === "undefined") return;
  const previous = getSettingsRecord();
  if (previous && JSON.stringify(previous.values) === JSON.stringify(settings)) return;
  saveRecord({ values: settings, updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1) });
}

export function getSettingsRecord(): SettingsRecord | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { updatedAt?: number };
    return { values: getSettings(), updatedAt: Number.isSafeInteger(parsed.updatedAt) && parsed.updatedAt! > 0 ? parsed.updatedAt! : 1 };
  } catch { return null; }
}

export function getPendingSettings(accountId: string | null): SettingsRecord | null {
  if (!accountId || typeof localStorage === "undefined") return null;
  const record = getSettingsRecord();
  const ack = Number(localStorage.getItem(ACK_KEY + encodeURIComponent(accountId)) ?? 0);
  return record && record.updatedAt !== ack ? record : null;
}

function saveRecord(record: SettingsRecord): void {
  const values = { ...record.values, fontSize: Math.max(16, record.values.fontSize) };
  // Keep the existing flat format readable by older clients. Revision and values
  // share one write, so a storage failure cannot acknowledge unsaved settings.
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...values, updatedAt: record.updatedAt }));
  applySettings(values);
  for (const listener of listeners) listener(values);
}

export function acceptSettings(record: SettingsRecord, accountId: string, sent?: SettingsRecord): boolean {
  if (!isSettingsRecord(record)) return false;
  const current = getSettingsRecord();
  if (sent ? current?.updatedAt !== sent.updatedAt : getPendingSettings(accountId) !== null) return false;
  if (current && record.updatedAt < current.updatedAt) return false;
  saveRecord(record);
  localStorage.setItem(ACK_KEY + encodeURIComponent(accountId), String(record.updatedAt));
  return true;
}

export function subscribeSettings(listener: (settings: Settings) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function applySettings(settings: Settings): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--editor-font-size", `${settings.fontSize}px`);
  root.style.setProperty("--editor-line-height", String(settings.lineHeight));
  root.dataset.theme = settings.theme;
  root.dataset.verticalWriting = String(settings.verticalWriting);
}
