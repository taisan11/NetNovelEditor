import { createSignal, createEffect, Show, onMount, onCleanup } from "solid-js"
import {
  getSyosetu,
  getChapter,
  setChapter,
  setSyosetu,
  deleteChapter,
} from "../storage"
import type { Syosetu, Chapter } from "../storage"
import { navigate } from "../App"
import { autoPushOnNavigate, hasPendingPush } from "../sync"

type Tab = "honbun" | "preview" | "plot"
type HistoryState = { stack: string[]; index: number }
const HISTORY_LIMIT = 200
const HISTORY_DEBOUNCE_MS = 500

function renderHonbun(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  return escaped.replace(
    /\|([^|《》]+)《([^》]+)》/g,
    "<ruby>$1<rt>$2</rt></ruby>",
  )
}

function createHistory() {
  const [history, setHistory] = createSignal<HistoryState>({ stack: [], index: -1 })

  const init = (value: string) => {
    setHistory({ stack: [value], index: 0 })
  }

  const push = (value: string) => {
    const h = history()
    if (h.index >= 0 && h.stack[h.index] === value) return
    const newStack = [...h.stack.slice(0, h.index + 1), value]
    while (newStack.length > HISTORY_LIMIT) newStack.shift()
    setHistory({ stack: newStack, index: newStack.length - 1 })
  }

  const undo = (): string | null => {
    const h = history()
    if (h.index <= 0) return null
    const newIndex = h.index - 1
    setHistory({ ...h, index: newIndex })
    return h.stack[newIndex]
  }

  const redo = (): string | null => {
    const h = history()
    if (h.index >= h.stack.length - 1) return null
    const newIndex = h.index + 1
    setHistory({ ...h, index: newIndex })
    return h.stack[newIndex]
  }

  return {
    init,
    push,
    undo,
    redo,
    canUndo: () => history().index > 0,
    canRedo: () => history().index < history().stack.length - 1,
  }
}

export default function ChapterEditPage(props: { syosetuTitle: string; page: number }) {
  const [work, setWork] = createSignal<Syosetu | null>(null)
  const [chapter, setChapterData] = createSignal<Chapter | null>(null)
  const [tab, setTab] = createSignal<Tab>("honbun")

  const [honbun, setHonbun] = createSignal("")
  const [plot, setPlot] = createSignal("")

  const [honbunDirty, setHonbunDirty] = createSignal(false)
  const [plotDirty, setPlotDirty] = createSignal(false)

  const honbunHistory = createHistory()
  const plotHistory = createHistory()

  let honbunTimer: ReturnType<typeof setTimeout> | null = null
  let plotTimer: ReturnType<typeof setTimeout> | null = null

  let honbunTextareaRef: HTMLTextAreaElement | undefined
  let plotTextareaRef: HTMLTextAreaElement | undefined

  const clearHonbunTimer = () => {
    if (honbunTimer) {
      clearTimeout(honbunTimer)
      honbunTimer = null
    }
  }

  const clearPlotTimer = () => {
    if (plotTimer) {
      clearTimeout(plotTimer)
      plotTimer = null
    }
  }

  const scheduleHonbunHistory = () => {
    clearHonbunTimer()
    honbunTimer = setTimeout(() => {
      honbunHistory.push(honbun())
      honbunTimer = null
    }, HISTORY_DEBOUNCE_MS)
  }

  const schedulePlotHistory = () => {
    clearPlotTimer()
    plotTimer = setTimeout(() => {
      plotHistory.push(plot())
      plotTimer = null
    }, HISTORY_DEBOUNCE_MS)
  }

  const restoreCaret = (
    textarea: HTMLTextAreaElement | undefined,
    position: number,
  ) => {
    if (!textarea) return
    queueMicrotask(() => {
      textarea.focus()
      textarea.setSelectionRange(position, position)
    })
  }

  const applyHonbun = (value: string) => {
    clearHonbunTimer()
    setHonbun(value)
    setHonbunDirty(true)
    restoreCaret(honbunTextareaRef, value.length)
  }

  const applyPlot = (value: string) => {
    clearPlotTimer()
    setPlot(value)
    setPlotDirty(true)
    restoreCaret(plotTextareaRef, value.length)
  }

  const undoHonbun = () => {
    const prev = honbunHistory.undo()
    if (prev !== null) applyHonbun(prev)
  }

  const redoHonbun = () => {
    const next = honbunHistory.redo()
    if (next !== null) applyHonbun(next)
  }

  const undoPlot = () => {
    const prev = plotHistory.undo()
    if (prev !== null) applyPlot(prev)
  }

  const redoPlot = () => {
    const next = plotHistory.redo()
    if (next !== null) applyPlot(next)
  }

  createEffect(() => {
    const title = props.syosetuTitle
    const page = props.page
    const w = getSyosetu(title)
    const c = getChapter(title, page)
    setWork(w)
    setChapterData(c)
    const honbunValue = c?.honbun ?? ""
    const plotValue = w?.plot ?? ""
    setHonbun(honbunValue)
    setPlot(plotValue)
    setHonbunDirty(false)
    setPlotDirty(false)
    setTab("honbun")
    honbunHistory.init(honbunValue)
    plotHistory.init(plotValue)
    clearHonbunTimer()
    clearPlotTimer()
  })

  const persistHonbun = () => {
    const c = chapter()
    if (!c) return
    setChapter({ ...c, honbun: honbun() })
    setHonbunDirty(false)
  }

  const persistPlot = () => {
    const w = work()
    if (!w) return
    setSyosetu({ ...w, plot: plot() })
    setWork({ ...w, plot: plot() })
    setPlotDirty(false)
  }

  const insertRuby = (textarea: HTMLTextAreaElement | undefined) => {
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const value = honbun()
    const selected = value.slice(start, end)
    let inserted: string
    let cursorOffset: number
    if (selected) {
      inserted = `|${selected}《》`
      cursorOffset = start + inserted.length - 1
    } else {
      inserted = "|《》"
      cursorOffset = start + 2
    }
    const next = value.slice(0, start) + inserted + value.slice(end)
    setHonbun(next)
    setHonbunDirty(true)
    scheduleHonbunHistory()
    textarea.focus()
    textarea.setSelectionRange(cursorOffset, cursorOffset)
  }

  const handleDeleteChapter = () => {
    const c = chapter()
    if (!c) return
    if (!confirm(`チャプター「${c.title}」を削除しますか？`)) return
    persistHonbun()
    deleteChapter(c.Syosetu_title, c.page)
    navigate(`/${encodeURIComponent(props.syosetuTitle)}`)
  }

  const goWork = () => navigate(`/${encodeURIComponent(props.syosetuTitle)}`)

  const handleKeydown = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return
    if (e.altKey) return
    const key = e.key.toLowerCase()
    if (key !== "z" && key !== "y") return
    const activeTab = tab()
    if (activeTab === "preview") return
    e.preventDefault()
    const isRedo = key === "y" || (key === "z" && e.shiftKey)
    if (activeTab === "honbun") {
      if (isRedo) redoHonbun()
      else undoHonbun()
    } else if (activeTab === "plot") {
      if (isRedo) redoPlot()
      else undoPlot()
    }
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeydown)
  })

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeydown)
    clearHonbunTimer()
    clearPlotTimer()
    if (hasPendingPush()) void autoPushOnNavigate()
  })

  return (
    <Show
      when={work() && chapter()}
      fallback={
        <section>
          <p class="error">チャプターが見つかりません。</p>
          <button onClick={goWork}>← チャプター一覧へ戻る</button>
        </section>
      }
    >
      <nav class="breadcrumb">
        <a
          href={`#/${encodeURIComponent(props.syosetuTitle)}`}
          onClick={(e) => {
            e.preventDefault()
            goWork()
          }}
        >
          ← {work()!.title}
        </a>
      </nav>
      <div class="chapter-header">
        <h1>
          {chapter()!.page}. {chapter()!.title}
        </h1>
        <button
          type="button"
          class="danger"
          onClick={handleDeleteChapter}
          aria-label="このチャプターを削除"
        >
          チャプターを削除
        </button>
      </div>

      <div class="tabs-row">
        <div class="tabs" role="tablist">
          <button
            role="tab"
            class={tab() === "honbun" ? "tab active" : "tab"}
            aria-selected={tab() === "honbun"}
            onClick={() => setTab("honbun")}
          >
            本文
          </button>
          <button
            role="tab"
            class={tab() === "preview" ? "tab active" : "tab"}
            aria-selected={tab() === "preview"}
            onClick={() => setTab("preview")}
          >
            プレビュー
          </button>
          <button
            role="tab"
            class={tab() === "plot" ? "tab active" : "tab"}
            aria-selected={tab() === "plot"}
            onClick={() => setTab("plot")}
          >
            プロット
          </button>
        </div>
        <Show when={tab() === "honbun"}>
          <div class="editor-toolbar">
            <button
              type="button"
              onClick={undoHonbun}
              disabled={!honbunHistory.canUndo()}
              title="元に戻す (Ctrl+Z)"
              aria-label="本文を元に戻す"
            >
              ↶ 元に戻す
            </button>
            <button
              type="button"
              onClick={redoHonbun}
              disabled={!honbunHistory.canRedo()}
              title="やり直し (Ctrl+Y / Ctrl+Shift+Z)"
              aria-label="本文のやり直し"
            >
              ↷ やり直し
            </button>
            <button
              type="button"
              class="ruby-btn"
              onClick={() => insertRuby(honbunTextareaRef)}
              title="選択中の文字を |《》 で囲みます"
            >
              ルビ入力
            </button>
          </div>
        </Show>
        <Show when={tab() === "plot"}>
          <div class="editor-toolbar">
            <button
              type="button"
              onClick={undoPlot}
              disabled={!plotHistory.canUndo()}
              title="元に戻す (Ctrl+Z)"
              aria-label="プロットを元に戻す"
            >
              ↶ 元に戻す
            </button>
            <button
              type="button"
              onClick={redoPlot}
              disabled={!plotHistory.canRedo()}
              title="やり直し (Ctrl+Y / Ctrl+Shift+Z)"
              aria-label="プロットのやり直し"
            >
              ↷ やり直し
            </button>
          </div>
        </Show>
      </div>

      <Show when={tab() === "honbun"}>
        <textarea
          ref={honbunTextareaRef}
          class="editor"
          value={honbun()}
          onInput={(e) => {
            setHonbun(e.currentTarget.value)
            setHonbunDirty(true)
            scheduleHonbunHistory()
          }}
          onBlur={persistHonbun}
          rows={20}
          placeholder="ここに本文を書いてください"
        />
        <div class="actions">
          <span class="muted">{honbunDirty() ? "未保存の変更あり" : "保存済み"}</span>
          <button onClick={persistHonbun} disabled={!honbunDirty()}>
            保存
          </button>
        </div>
      </Show>

      <Show when={tab() === "preview"}>
        <div class="preview" innerHTML={renderHonbun(honbun())} />
      </Show>

      <Show when={tab() === "plot"}>
        <textarea
          ref={plotTextareaRef}
          class="editor"
          value={plot()}
          onInput={(e) => {
            setPlot(e.currentTarget.value)
            setPlotDirty(true)
            schedulePlotHistory()
          }}
          onBlur={persistPlot}
          rows={20}
          placeholder="作品全体のプロット・構成メモ"
        />
        <div class="actions">
          <span class="muted">{plotDirty() ? "未保存の変更あり" : "保存済み"}</span>
          <button onClick={persistPlot} disabled={!plotDirty()}>
            保存
          </button>
        </div>
      </Show>
    </Show>
  )
}
