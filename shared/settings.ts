export type Theme = "light" | "dark" | "sepia";

export interface Settings {
  fontSize: number;
  lineHeight: number;
  theme: Theme;
  verticalWriting: boolean;
}

export interface SettingsRecord {
  values: Settings;
  updatedAt: number;
}

export function isSettings(value: unknown): value is Settings {
  if (!value || typeof value !== "object") return false;
  const s = value as Settings;
  return Number.isFinite(s.fontSize) && s.fontSize >= 10 && s.fontSize <= 32 &&
    Number.isFinite(s.lineHeight) && s.lineHeight >= 1 && s.lineHeight <= 3 &&
    ["light", "dark", "sepia"].includes(s.theme) && typeof s.verticalWriting === "boolean";
}

export function isSettingsRecord(value: unknown): value is SettingsRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as SettingsRecord;
  return isSettings(record.values) && Number.isSafeInteger(record.updatedAt) && record.updatedAt > 0 &&
    Number.isFinite(new Date(record.updatedAt).getTime());
}
