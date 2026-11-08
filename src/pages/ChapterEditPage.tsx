import { createSignal, createEffect, Show, onMount, onCleanup } from "solid-js";
import { getSyosetu, getChapter, saveChapter, saveSyosetu, deleteChapter } from "../storage";
import type { Syosetu, Chapter } from "../storage";
import { navigate } from "../App";
import { subscribeSync } from "../sync";
import { getSettings } from "../settings";
import Trash from "lucide-solid/icons/trash";
import RotateCcw from "lucide-solid/icons/rotate-ccw";
import RotateCw from "lucide-solid/icons/rotate-cw";
import TextCursorInput from "lucide-solid/icons/text-cursor-input";
import Save from "lucide-solid/icons/save";
import Settings from "lucide-solid/icons/settings";

type Tab = "honbun" | "preview" | "plot";
type HistoryState = { stack: string[]; index: number };
const HISTORY_LIMIT = 200;
const HISTORY_DEBOUNCE_MS = 500;

function renderHonbun(text: string): string {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(/\|([^|《》]+)《([^》]+)》/g, "<ruby>$1<rt>$2</rt></ruby>");
}

function createHistory(readValue: () => string) {
  const [history, setHistory] = createSignal<HistoryState>({ stack: [], index: -1 });
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  onCleanup(cancel);

  const init = (value: string) => {
    cancel();
    setHistory({ stack: [value], index: 0 });
  };

  const push = (value: string) => {
    const h = history();
    if (h.index >= 0 && h.stack[h.index] === value) return;
    const newStack = [...h.stack.slice(0, h.index + 1), value];
    while (newStack.length > HISTORY_LIMIT) newStack.shift();
    setHistory({ stack: newStack, index: newStack.length - 1 });
  };

  const move = (offset: number): string | null => {
    const h = history();
    const newIndex = h.index + offset;
    if (newIndex < 0 || newIndex >= h.stack.length) return null;
    setHistory({ ...h, index: newIndex });
    return h.stack[newIndex];
  };

  return {
    init,
    cancel,
    schedule: () => {
      cancel();
      timer = setTimeout(() => {
        push(readValue());
        timer = null;
      }, HISTORY_DEBOUNCE_MS);
    },
    undo: () => move(-1),
    redo: () => move(1),
    canUndo: () => history().index > 0,
    canRedo: () => history().index < history().stack.length - 1,
  };
}

export default function ChapterEditPage(props: { syosetuTitle: string; page: number }) {
  const [work, setWork] = createSignal<Syosetu | null>(null);
  const [chapter, setChapterData] = createSignal<Chapter | null>(null);
  const [tab, setTab] = createSignal<Tab>("honbun");

  const [honbun, setHonbun] = createSignal("");
  const [plot, setPlot] = createSignal("");

  const [honbunDirty, setHonbunDirty] = createSignal(false);
  const [plotDirty, setPlotDirty] = createSignal(false);

  const honbunHistory = createHistory(honbun);
  const plotHistory = createHistory(plot);

  let honbunTextareaRef: HTMLTextAreaElement | undefined;
  let plotTextareaRef: HTMLTextAreaElement | undefined;

  const restoreCaret = (textarea: HTMLTextAreaElement | undefined, position: number) => {
    if (!textarea) return;
    queueMicrotask(() => {
      textarea.focus();
      textarea.setSelectionRange(position, position);
    });
  };

  const applyHonbun = (value: string) => {
    honbunHistory.cancel();
    setHonbun(value);
    setHonbunDirty(true);
    restoreCaret(honbunTextareaRef, value.length);
  };

  const applyPlot = (value: string) => {
    plotHistory.cancel();
    setPlot(value);
    setPlotDirty(true);
    restoreCaret(plotTextareaRef, value.length);
  };

  const undoHonbun = () => {
    const prev = honbunHistory.undo();
    if (prev !== null) applyHonbun(prev);
  };

  const redoHonbun = () => {
    const next = honbunHistory.redo();
    if (next !== null) applyHonbun(next);
  };

  const undoPlot = () => {
    const prev = plotHistory.undo();
    if (prev !== null) applyPlot(prev);
  };

  const redoPlot = () => {
    const next = plotHistory.redo();
    if (next !== null) applyPlot(next);
  };

  createEffect(() => {
    const title = props.syosetuTitle;
    const page = props.page;
    const w = getSyosetu(title);
    const c = getChapter(title, page);
    setWork(w);
    setChapterData(c);
    const honbunValue = c?.honbun ?? "";
    const plotValue = w?.plot ?? "";
    setHonbun(honbunValue);
    setPlot(plotValue);
    setHonbunDirty(false);
    setPlotDirty(false);
    setTab("honbun");
    honbunHistory.init(honbunValue);
    plotHistory.init(plotValue);
  });

  const persistHonbun = () => {
    const c = getChapter(props.syosetuTitle, props.page) ?? chapter();
    if (!c || !honbunDirty()) return;
    const nextHonbun = honbun();
    const saved = saveChapter({
      ...c,
      honbun: nextHonbun,
    });
    setChapterData(saved);
    setHonbunDirty(false);
  };

  const persistPlot = () => {
    const w = getSyosetu(props.syosetuTitle) ?? work();
    if (!w || !plotDirty()) return;
    setWork(saveSyosetu({ ...w, plot: plot() }));
    setPlotDirty(false);
  };

  const insertRuby = (textarea: HTMLTextAreaElement | undefined) => {
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = honbun();
    const selected = value.slice(start, end);
    let inserted: string;
    let cursorOffset: number;
    if (selected) {
      inserted = `|${selected}《》`;
      cursorOffset = start + inserted.length - 1;
    } else {
      inserted = "|《》";
      cursorOffset = start + 2;
    }
    const next = value.slice(0, start) + inserted + value.slice(end);
    setHonbun(next);
    setHonbunDirty(true);
    honbunHistory.schedule();
    textarea.focus();
    textarea.setSelectionRange(cursorOffset, cursorOffset);
  };

  const handleDeleteChapter = () => {
    const c = chapter();
    if (!c) return;
    if (!confirm(`話「${c.title}」を削除しますか？`)) return;
    persistHonbun();
    deleteChapter(c.Syosetu_title, c.page);
    navigate(`/${encodeURIComponent(props.syosetuTitle)}`);
  };

  const goWork = () => navigate(`/${encodeURIComponent(props.syosetuTitle)}`);

  const goSettings = () => navigate("/settings");

  const isVerticalWriting = () => getSettings().verticalWriting;

  const handleKeydown = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.altKey) return;
    const key = e.key.toLowerCase();
    if (key !== "z" && key !== "y") return;
    const activeTab = tab();
    if (activeTab === "preview") return;
    e.preventDefault();
    const isRedo = key === "y" || (key === "z" && e.shiftKey);
    if (activeTab === "honbun") {
      if (isRedo) redoHonbun();
      else undoHonbun();
    } else if (activeTab === "plot") {
      if (isRedo) redoPlot();
      else undoPlot();
    }
  };

  onMount(() => {
    document.addEventListener("keydown", handleKeydown);
    onCleanup(
      subscribeSync((state) => {
        if (state.status === "syncing") return;
        const w = getSyosetu(props.syosetuTitle);
        const c = getChapter(props.syosetuTitle, props.page);
        // Background downloads must not reset a draft, its caret or undo history.
        if ((!w || !c) && (honbunDirty() || plotDirty())) return;
        setWork(w);
        setChapterData(c);
        if (c && !honbunDirty() && honbun() !== c.honbun) {
          setHonbun(c.honbun);
          honbunHistory.init(c.honbun);
        }
        if (w && !plotDirty() && plot() !== w.plot) {
          setPlot(w.plot);
          plotHistory.init(w.plot);
        }
      }),
    );
  });

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeydown);
    // Route changes can unmount the editor before a textarea blur is
    // delivered. Persist the current signals before route synchronization.
    if (honbunDirty()) persistHonbun();
    if (plotDirty()) persistPlot();
  });

  return (
    <Show
      when={work() && chapter()}
      fallback={
        <section>
          <p class="error">話が見つかりません。</p>
          <button onClick={goWork}>← 話一覧へ戻る</button>
        </section>
      }
    >
      <nav class="breadcrumb">
        <a
          href={`#/${encodeURIComponent(props.syosetuTitle)}`}
          onClick={(e) => {
            e.preventDefault();
            goWork();
          }}
        >
          ← {work()!.title}
        </a>
      </nav>
      <div class="chapter-header">
        <h1>
          {chapter()!.page}. {chapter()!.title}
        </h1>
        <div class="chapter-header-actions">
          <button
            type="button"
            class="header-btn"
            onClick={goSettings}
            title="設定"
            aria-label="設定を開く"
          >
            <Settings size={16} />
          </button>
          <button
            type="button"
            class="danger"
            onClick={handleDeleteChapter}
            aria-label="この話を削除"
          >
            <Trash size={16} />
            話を削除
          </button>
        </div>
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
        <Show when={tab() !== "preview"}>
          <div class="editor-toolbar">
            <button
              type="button"
              onClick={() => (tab() === "honbun" ? undoHonbun() : undoPlot())}
              disabled={!(tab() === "honbun" ? honbunHistory : plotHistory).canUndo()}
              title="元に戻す (Ctrl+Z)"
              aria-label={`${tab() === "honbun" ? "本文" : "プロット"}を元に戻す`}
            >
              <RotateCcw size={16} />
              元に戻す
            </button>
            <button
              type="button"
              onClick={() => (tab() === "honbun" ? redoHonbun() : redoPlot())}
              disabled={!(tab() === "honbun" ? honbunHistory : plotHistory).canRedo()}
              title="やり直し (Ctrl+Y / Ctrl+Shift+Z)"
              aria-label={`${tab() === "honbun" ? "本文" : "プロット"}のやり直し`}
            >
              <RotateCw size={16} />
              やり直し
            </button>
            <Show when={tab() === "honbun"}>
              <button
                type="button"
                class="ruby-btn"
                onClick={() => insertRuby(honbunTextareaRef)}
                title="選択中の文字を |《》 で囲みます"
              >
                <TextCursorInput size={16} />
                ルビ入力
              </button>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={tab() === "honbun"}>
        <textarea
          ref={(element) => { honbunTextareaRef = element; }}
          class={`editor ${isVerticalWriting() ? "vertical" : ""}`}
          value={honbun()}
          onInput={(e) => {
            setHonbun(e.currentTarget.value);
            setHonbunDirty(true);
            honbunHistory.schedule();
          }}
          onBlur={persistHonbun}
          rows={20}
          placeholder="ここに本文を書いてください"
        />
        <div class="actions">
          <span class="muted">{honbunDirty() ? "未保存の変更あり" : "保存済み"}</span>
          <button onClick={persistHonbun} disabled={!honbunDirty()}>
            <Save size={16} />
            保存
          </button>
        </div>
      </Show>

      <Show when={tab() === "preview"}>
        <div
          class={`preview ${isVerticalWriting() ? "vertical" : ""}`}
          innerHTML={renderHonbun(honbun())}
        />
      </Show>

      <Show when={tab() === "plot"}>
        <textarea
          ref={(element) => { plotTextareaRef = element; }}
          class={`editor ${isVerticalWriting() ? "vertical" : ""}`}
          value={plot()}
          onInput={(e) => {
            setPlot(e.currentTarget.value);
            setPlotDirty(true);
            plotHistory.schedule();
          }}
          onBlur={persistPlot}
          rows={20}
          placeholder="作品全体のプロット・構成メモ"
        />
        <div class="actions">
          <span class="muted">{plotDirty() ? "未保存の変更あり" : "保存済み"}</span>
          <button onClick={persistPlot} disabled={!plotDirty()}>
            <Save size={16} />
            保存
          </button>
        </div>
      </Show>
    </Show>
  );
}
