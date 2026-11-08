import { createSignal, onMount, onCleanup, Show } from "solid-js"
import HomePage from "./pages/HomePage"
import WorkPage from "./pages/WorkPage"
import ChapterEditPage from "./pages/ChapterEditPage"
import SettingsPage from "./pages/SettingsPage"
import { getSettings, applySettings } from "./settings"
import { autoSyncOnNavigate, getSyncState, startAutoSync, subscribeSync } from "./sync"

export type Route =
  | { name: "home" }
  | { name: "work"; title: string }
  | { name: "chapter"; syosetuTitle: string; page: number }
  | { name: "settings" }

const [getRoute, setRoute] = createSignal<Route>({ name: "home" })

function parseHash(hash: string): Route {
  const cleaned = hash.replace(/^#\/?/, "")
  if (!cleaned) return { name: "home" }
  if (cleaned === "settings") return { name: "settings" }
  const parts = cleaned.split("/").map((p) => decodeURIComponent(p))
  if (parts.length === 1) {
    return { name: "work", title: parts[0] }
  }
  if (parts.length === 2) {
    const page = Number(parts[1])
    if (Number.isFinite(page)) {
      return { name: "chapter", syosetuTitle: parts[0], page }
    }
  }
  return { name: "home" }
}

export function navigate(to: string) {
  const path = "/" + to.replace(/^\/+/, "").replace(/\/+$/, "")
  const hash = `#${path}`
  if (window.location.hash === hash) {
    setRoute(parseHash(path))
  } else {
    window.location.hash = path
  }
}

export default function App() {
  const [syncState, setSyncState] = createSignal(getSyncState())
  onMount(() => {
    applySettings(getSettings())
    setRoute(parseHash(window.location.hash))
    const handleHashChange = () => {
      setRoute(parseHash(window.location.hash))
      // Let editor cleanup persist its draft before collecting upload records.
      queueMicrotask(() => { void autoSyncOnNavigate() })
    }
    window.addEventListener("hashchange", handleHashChange)
    const unsubscribe = subscribeSync(setSyncState)
    const stopAutoSync = startAutoSync()
    onCleanup(() => {
      window.removeEventListener("hashchange", handleHashChange)
      unsubscribe()
      stopAutoSync()
    })
  })

  return (
    <main class="container">
      <Show when={syncState().status === "syncing"}>
        <div class="sync-indicator" role="status" aria-live="polite">
          <span class="sync-spinner" aria-hidden="true" />
          クラウドと同期中…
        </div>
      </Show>
      <Show when={getRoute().name === "home"}>
        <HomePage />
      </Show>
      <Show
        when={getRoute().name === "work"}
        children={
          <WorkPage title={(getRoute() as { name: "work"; title: string }).title} />
        }
      />
      <Show
        when={getRoute().name === "chapter"}
        children={
          <ChapterEditPage
            syosetuTitle={(getRoute() as { name: "chapter"; syosetuTitle: string; page: number }).syosetuTitle}
            page={(getRoute() as { name: "chapter"; syosetuTitle: string; page: number }).page}
          />
        }
      />
      <Show when={getRoute().name === "settings"}>
        <SettingsPage />
      </Show>
    </main>
  )
}
