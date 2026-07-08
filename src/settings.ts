export type Theme = "light" | "dark" | "sepia"

export interface Settings {
  fontSize: number
  lineHeight: number
  theme: Theme
  verticalWriting: boolean
}

export const SETTINGS_KEY = "netnoveleditor_settings_v1"

const DEFAULT_SETTINGS: Settings = {
  fontSize: 16,
  lineHeight: 1.7,
  theme: "light",
  verticalWriting: false,
}

const VALID_THEMES: Theme[] = ["light", "dark", "sepia"]

export function getSettings(): Settings {
  if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS }
  const data = localStorage.getItem(SETTINGS_KEY)
  if (!data) return { ...DEFAULT_SETTINGS }
  try {
    const parsed = JSON.parse(data) as Partial<Settings>
    return {
      fontSize:
        typeof parsed.fontSize === "number" && parsed.fontSize >= 10 && parsed.fontSize <= 32
          ? parsed.fontSize
          : DEFAULT_SETTINGS.fontSize,
      lineHeight:
        typeof parsed.lineHeight === "number" && parsed.lineHeight >= 1.0 && parsed.lineHeight <= 3.0
          ? parsed.lineHeight
          : DEFAULT_SETTINGS.lineHeight,
      theme: VALID_THEMES.includes(parsed.theme as Theme)
        ? (parsed.theme as Theme)
        : DEFAULT_SETTINGS.theme,
      verticalWriting:
        typeof parsed.verticalWriting === "boolean"
          ? parsed.verticalWriting
          : DEFAULT_SETTINGS.verticalWriting,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function setSettings(settings: Settings): void {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function applySettings(settings: Settings): void {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.style.setProperty("--editor-font-size", `${settings.fontSize}px`)
  root.style.setProperty("--editor-line-height", String(settings.lineHeight))
  root.dataset.theme = settings.theme
  root.dataset.verticalWriting = String(settings.verticalWriting)
}
