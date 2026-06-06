import { createSignal, createEffect, For, Show, onCleanup } from "solid-js"
import {
  getSyosetu,
  setSyosetu,
  listChapters,
  setChapter,
  deleteChapter,
  nextChapterPage,
} from "../storage"
import type { Syosetu, Chapter } from "../storage"
import { navigate } from "../App"
import { autoPushOnNavigate, hasPendingPush } from "../sync"

export default function WorkPage(props: { title: string }) {
  const [work, setWork] = createSignal<Syosetu | null>(null)
  const [chapters, setChapters] = createSignal<Chapter[]>([])
  const [newChapterTitle, setNewChapterTitle] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)

  const refresh = () => {
    const w = getSyosetu(props.title)
    setWork(w)
    setChapters(w ? listChapters(props.title) : [])
  }

  createEffect(() => {
    refresh()
  })

  onCleanup(() => {
    if (hasPendingPush()) void autoPushOnNavigate()
  })

  const handleAddChapter = (e: Event) => {
    e.preventDefault()
    const title = newChapterTitle().trim()
    if (!title) {
      setError("チャプタータイトルを入力してください")
      return
    }
    const w = work()
    if (!w) {
      setError("作品が見つかりません")
      return
    }
    const page = nextChapterPage(props.title)
    setChapter({ Syosetu_title: props.title, title, page, honbun: "" })
    setSyosetu({ ...w, pages: page })
    setNewChapterTitle("")
    setError(null)
    refresh()
  }

  const openChapter = (page: number) => {
    navigate(`/${encodeURIComponent(props.title)}/${page}`)
  }

  const handleDeleteChapter = (chapter: Chapter) => {
    if (!confirm(`チャプター「${chapter.title}」を削除しますか？`)) return
    deleteChapter(chapter.Syosetu_title, chapter.page)
    refresh()
  }

  const goHome = () => navigate("")

  return (
    <Show
      when={work()}
      fallback={
        <section>
          <p class="error">作品「{props.title}」が見つかりません。</p>
          <button onClick={goHome}>← 作品一覧へ戻る</button>
        </section>
      }
    >
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
      <h1>{work()!.title}</h1>
      <p class="muted">{chapters().length} 章</p>

      <h2>チャプター一覧</h2>
      <Show
        when={chapters().length > 0}
        fallback={<p class="empty">まだチャプターがありません。下のフォームから追加してください。</p>}
      >
        <ul class="list">
          <For each={chapters()}>
            {(chapter) => (
              <li class="list-row">
                <a
                  href={`#/${encodeURIComponent(props.title)}/${chapter.page}`}
                  onClick={(e) => {
                    e.preventDefault()
                    openChapter(chapter.page)
                  }}
                >
                  {chapter.page}. {chapter.title}
                </a>
                <button
                  type="button"
                  class="danger small"
                  onClick={() => handleDeleteChapter(chapter)}
                  aria-label={`チャプター「${chapter.title}」を削除`}
                >
                  削除
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <form onSubmit={handleAddChapter} class="new-chapter">
        <input
          type="text"
          placeholder="チャプタータイトル"
          value={newChapterTitle()}
          onInput={(e) => setNewChapterTitle(e.currentTarget.value)}
        />
        <button type="submit">チャプターを追加</button>
      </form>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </Show>
  )
}
