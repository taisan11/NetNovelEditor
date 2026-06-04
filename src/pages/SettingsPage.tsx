import { createSignal, createEffect, Show } from "solid-js"
import { exportBackup, importBackup } from "../storage"
import { getSettings, setSettings, applySettings } from "../settings"
import type { Theme } from "../settings"
import { navigate } from "../App"

type Message = { kind: "success" | "error"; text: string }

export default function SettingsPage() {
  const initial = getSettings()
  const [fontSize, setFontSize] = createSignal(initial.fontSize)
  const [lineHeight, setLineHeight] = createSignal(initial.lineHeight)
  const [theme, setTheme] = createSignal<Theme>(initial.theme)
  const [message, setMessage] = createSignal<Message | null>(null)

  createEffect(() => {
    const s = { fontSize: fontSize(), lineHeight: lineHeight(), theme: theme() }
    setSettings(s)
    applySettings(s)
  })

  const handleBackup = () => {
    try {
      const json = exportBackup()
      const blob = new Blob([json], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      a.href = url
      a.download = `netnoveleditor-backup-${stamp}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setMessage({ kind: "success", text: "バックアップをダウンロードしました" })
    } catch (err) {
      setMessage({
        kind: "error",
        text: `バックアップに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  const handleImport = (e: Event & { currentTarget: HTMLInputElement }) => {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ""
    if (!file) return
    if (!confirm("現在のすべての作品が上書きされます。続行しますか？")) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const json = String(reader.result ?? "")
        const result = importBackup(json)
        setMessage({
          kind: "success",
          text: `${result.works}作品・${result.chapters}チャプターをインポートしました。まもなく作品一覧へ移動します…`,
        })
        setTimeout(() => navigate(""), 1500)
      } catch (err) {
        setMessage({
          kind: "error",
          text: `インポートに失敗しました: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    }
    reader.onerror = () => {
      setMessage({ kind: "error", text: "ファイルの読み込みに失敗しました" })
    }
    reader.readAsText(file)
  }

  const goHome = () => navigate("")

  const selectTheme = (next: Theme) => {
    setTheme(next)
  }

  return (
    <section>
      <nav class="breadcrumb">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault()
            goHome()
          }}
        >
          ← 作品一覧
        </a>
      </nav>
      <h1>設定</h1>

      <h2>表示</h2>
      <div class="setting-row">
        <label for="font-size-input">
          フォントサイズ: <strong>{fontSize()}px</strong>
        </label>
        <input
          id="font-size-input"
          type="range"
          min="12"
          max="28"
          step="1"
          value={fontSize()}
          onInput={(e) => setFontSize(Number(e.currentTarget.value))}
        />
      </div>
      <div class="setting-row">
        <label for="line-height-input">
          行の高さ: <strong>{lineHeight().toFixed(1)}</strong>
        </label>
        <input
          id="line-height-input"
          type="range"
          min="1.2"
          max="2.4"
          step="0.1"
          value={lineHeight()}
          onInput={(e) => setLineHeight(Number(e.currentTarget.value))}
        />
      </div>

      <h2>テーマ</h2>
      <div class="theme-options" role="radiogroup" aria-label="テーマ">
        <label class={theme() === "light" ? "theme-option active" : "theme-option"}>
          <input
            type="radio"
            name="theme"
            value="light"
            checked={theme() === "light"}
            onChange={() => selectTheme("light")}
          />
          <span class="theme-preview light-preview">ライト</span>
        </label>
        <label class={theme() === "dark" ? "theme-option active" : "theme-option"}>
          <input
            type="radio"
            name="theme"
            value="dark"
            checked={theme() === "dark"}
            onChange={() => selectTheme("dark")}
          />
          <span class="theme-preview dark-preview">ダーク</span>
        </label>
        <label class={theme() === "sepia" ? "theme-option active" : "theme-option"}>
          <input
            type="radio"
            name="theme"
            value="sepia"
            checked={theme() === "sepia"}
            onChange={() => selectTheme("sepia")}
          />
          <span class="theme-preview sepia-preview">セピア</span>
        </label>
      </div>

      <h2>バックアップ&インポート</h2>
      <p class="muted">
        作品データを単一のJSONファイルにバックアップ・復元します。インポートを行うと現在のすべての作品が上書きされるのでご注意ください。
      </p>
      <div class="backup-actions">
        <button type="button" onClick={handleBackup}>
          バックアップをダウンロード
        </button>
        <label class="file-input-label">
          ファイルからインポート
          <input type="file" accept="application/json,.json" onChange={handleImport} />
        </label>
      </div>
      <Show when={message()}>
        <p class={message()!.kind === "error" ? "error" : "success"}>
          {message()!.text}
        </p>
      </Show>
    </section>
  )
}
