import { createSignal, For, Show } from "solid-js"
import { listSyosetu, getSyosetu, setSyosetu, deleteSyosetu } from "../storage"
import type { Syosetu } from "../storage"
import { navigate } from "../App"
import { autoPushOnNavigate } from "../sync"

export default function HomePage() {
  const [newTitle, setNewTitle] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)
  const [works, setWorks] = createSignal<Syosetu[]>(listSyosetu())

  const refresh = () => setWorks(listSyosetu())

  const handleCreate = (e: Event) => {
    e.preventDefault()
    const title = newTitle().trim()
    if (!title) {
      setError("タイトルを入力してください")
      return
    }
    if (getSyosetu(title)) {
      setError("同じタイトルの作品が既に存在します")
      return
    }
    setSyosetu({ title, pages: 0, plot: "" })
    setNewTitle("")
    setError(null)
    refresh()
  }

  const open = (title: string) => {
    navigate(`/${encodeURIComponent(title)}`)
  }

  const openSettings = () => {
    navigate("/settings")
  }

  const handleDelete = (work: Syosetu) => {
    if (!confirm(`作品「${work.title}」を削除しますか？`)) return
    deleteSyosetu(work.title)
    refresh()
    void autoPushOnNavigate()
  }

  return (
    <section>
      <h1>NetNovelEditor</h1>
      <p class="muted">Web 上で小説を書いて、章ごとに管理するエディター</p>

      <form onSubmit={handleCreate} class="new-work">
        <input
          type="text"
          placeholder="作品タイトル"
          value={newTitle()}
          onInput={(e) => setNewTitle(e.currentTarget.value)}
        />
        <button type="submit">新規作品を作成</button>
      </form>
      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>

      <div class="list-header">
        <h2>作品一覧</h2>
        <button type="button" class="header-btn" onClick={openSettings}>
          設定
        </button>
      </div>
      <Show
        when={works().length > 0}
        fallback={<p class="empty">まだ作品がありません。上のフォームから作成してください。</p>}
      >
        <ul class="list">
          <For each={works()}>
            {(work) => (
              <li class="list-row">
                <a
                  href={`#/${encodeURIComponent(work.title)}`}
                  onClick={(e) => {
                    e.preventDefault()
                    open(work.title)
                  }}
                >
                  {work.title}
                </a>
                <span class="muted">（{work.pages} 章）</span>
                <button
                  type="button"
                  class="danger small"
                  onClick={() => handleDelete(work)}
                  aria-label={`作品「${work.title}」を削除`}
                >
                  削除
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
