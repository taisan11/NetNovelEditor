import {
  listDirtySyosetu,
  listDirtyChapters,
  listSyosetu,
  listChapters,
  getChapterById,
  markSyosetuClean,
  markChapterClean,
  setSyosetu,
  setChapter,
  removeDeletedTombstones,
  pendingPushCount,
  type Syosetu,
  type Chapter,
} from "./storage"

export type SyncStatus = "idle" | "syncing" | "error"

export interface SyncState {
  status: SyncStatus
  lastSyncAt: number | null
  lastError: string | null
  pendingPush: number
  lastResult: SyncResult | null
}

export interface SyncResult {
  pushedSyosetu: number
  pushedChapters: number
  pulledSyosetu: number
  pulledChapters: number
  serverWinsSyosetu: number
  serverWinsChapters: number
  clientWinsSyosetu: number
  clientWinsChapters: number
  startedAt: number
  finishedAt: number
}

const LISTENERS = new Set<(state: SyncState) => void>()

let state: SyncState = {
  status: "idle",
  lastSyncAt: null,
  lastError: null,
  pendingPush: 0,
  lastResult: null,
}

function emit(): void {
  for (const fn of LISTENERS) fn(state)
}

function setState(patch: Partial<SyncState>): void {
  state = { ...state, ...patch }
  emit()
}

function recomputePending(): void {
  const pending = pendingPushCount()
  if (state.pendingPush !== pending) {
    setState({ pendingPush: pending })
  }
}

export function hasPendingPush(): boolean {
  return pendingPushCount() > 0
}

export function getSyncState(): SyncState {
  recomputePending()
  return state
}

export function subscribeSync(fn: (s: SyncState) => void): () => void {
  LISTENERS.add(fn)
  fn(state)
  return () => {
    LISTENERS.delete(fn)
  }
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(url, {
      ...init,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    })
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const data = (await res.json()) as { error?: string }
        if (data?.error) msg = data.error
      } catch {}
      return { ok: false, status: res.status, error: msg }
    }
    const data = (await res.json()) as T
    return { ok: true, data }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

interface ServerSyosetu {
  id: string
  title: string
  pages: number
  plot: string
  createdAt: number
  updatedAt: number
  deleted: boolean
}

interface ServerChapter {
  id: string
  syosetuId: string
  title: string
  page: number
  honbun: string
  createdAt: number
  updatedAt: number
  deleted: boolean
}

interface SnapshotResponse {
  syosetu: ServerSyosetu[]
  chapters: ServerChapter[]
  serverTime: number
}

interface PushResultEntry {
  id: string
  winner: "client" | "server"
  server?: ServerSyosetu | ServerChapter
}

interface PushResponse {
  ok: boolean
  results: {
    syosetu: PushResultEntry[]
    chapters: PushResultEntry[]
  }
}

function toClientSyosetu(s: ServerSyosetu): Syosetu {
  return {
    id: s.id,
    title: s.title,
    pages: s.pages,
    plot: s.plot,
    updatedAt: s.updatedAt,
    deleted: s.deleted,
    dirty: false,
  }
}

function toClientChapter(c: ServerChapter, fallbackSyosetuTitle: string): Chapter {
  return {
    id: c.id,
    syosetuId: c.syosetuId,
    Syosetu_title: fallbackSyosetuTitle,
    title: c.title,
    page: c.page,
    honbun: c.honbun,
    updatedAt: c.updatedAt,
    deleted: c.deleted,
    dirty: false,
  }
}

export interface PushDirtyResult {
  ok: boolean
  pushedSyosetu: number
  pushedChapters: number
  serverWinsSyosetu: number
  serverWinsChapters: number
  error?: string
}

export async function pushDirty(): Promise<PushDirtyResult> {
  const dirtyS = listDirtySyosetu()
  const dirtyC = listDirtyChapters()
  if (dirtyS.length === 0 && dirtyC.length === 0) {
    recomputePending()
    return {
      ok: true,
      pushedSyosetu: 0,
      pushedChapters: 0,
      serverWinsSyosetu: 0,
      serverWinsChapters: 0,
    }
  }

  const res = await fetchJson<PushResponse>("/api/sync/push", {
    method: "POST",
    body: JSON.stringify({
      syosetu: dirtyS.map((s) => ({
        id: s.id,
        title: s.title,
        pages: s.pages,
        plot: s.plot,
        createdAt: s.updatedAt,
        updatedAt: s.updatedAt,
        deleted: !!s.deleted,
      })),
      chapters: dirtyC.map((c) => ({
        id: c.id,
        syosetuId: c.syosetuId,
        title: c.title,
        page: c.page,
        honbun: c.honbun,
        createdAt: c.updatedAt,
        updatedAt: c.updatedAt,
        deleted: !!c.deleted,
      })),
    }),
  })

  if (!res.ok) {
    return {
      ok: false,
      pushedSyosetu: 0,
      pushedChapters: 0,
      serverWinsSyosetu: 0,
      serverWinsChapters: 0,
      error: res.error,
    }
  }

  let pushedSyosetu = 0
  let pushedChapters = 0
  let serverWinsSyosetu = 0
  let serverWinsChapters = 0

  for (const r of res.data.results.syosetu) {
    if (r.winner === "client") {
      markSyosetuClean(r.id)
      pushedSyosetu++
    } else if (r.winner === "server" && r.server) {
      setSyosetu({ ...toClientSyosetu(r.server as ServerSyosetu), dirty: false })
      serverWinsSyosetu++
    }
  }
  for (const r of res.data.results.chapters) {
    if (r.winner === "client") {
      markChapterClean(r.id)
      pushedChapters++
    } else if (r.winner === "server" && r.server) {
      const server = r.server as ServerChapter
      const local = getChapterById(r.id)
      const fallbackTitle = local?.Syosetu_title ?? ""
      setChapter({ ...toClientChapter(server, fallbackTitle), dirty: false })
      serverWinsChapters++
    }
  }

  removeDeletedTombstones()
  recomputePending()
  return {
    ok: true,
    pushedSyosetu,
    pushedChapters,
    serverWinsSyosetu,
    serverWinsChapters,
  }
}

export interface PullResult {
  ok: boolean
  pulledSyosetu: number
  pulledChapters: number
  error?: string
}

export async function pullSnapshot(): Promise<PullResult> {
  const res = await fetchJson<SnapshotResponse>("/api/sync/snapshot")
  if (!res.ok) {
    return { ok: false, pulledSyosetu: 0, pulledChapters: 0, error: res.error }
  }

  const localSyosetu = new Map(listSyosetu().map((s) => [s.id, s]))
  const localChapters = new Map<string, Chapter>()
  for (const s of listSyosetu()) {
    for (const c of listChapters(s.title)) {
      localChapters.set(c.id, c)
    }
  }
  const titleBySyosetuId = new Map<string, string>()
  for (const s of listSyosetu()) titleBySyosetuId.set(s.id, s.title)

  let pulledSyosetu = 0
  let pulledChapters = 0

  for (const server of res.data.syosetu) {
    const local = localSyosetu.get(server.id)
    if (server.deleted) {
      if (local) {
        setSyosetu({ ...toClientSyosetu(server), dirty: false })
        pulledSyosetu++
      }
      continue
    }
    if (!local) {
      setSyosetu({ ...toClientSyosetu(server), dirty: false })
      titleBySyosetuId.set(server.id, server.title)
      pulledSyosetu++
      continue
    }
    if (server.updatedAt > local.updatedAt) {
      setSyosetu({ ...toClientSyosetu(server), dirty: false })
      titleBySyosetuId.set(server.id, server.title)
      pulledSyosetu++
    }
  }

  for (const server of res.data.chapters) {
    const local = localChapters.get(server.id)
    const syosetuTitle = titleBySyosetuId.get(server.syosetuId) ?? local?.Syosetu_title ?? ""
    if (!syosetuTitle) continue

    if (server.deleted) {
      if (local) {
        setChapter({ ...toClientChapter(server, syosetuTitle), dirty: false })
        pulledChapters++
      }
      continue
    }
    if (!local) {
      setChapter({ ...toClientChapter(server, syosetuTitle), dirty: false })
      pulledChapters++
      continue
    }
    if (server.updatedAt > local.updatedAt) {
      setChapter({ ...toClientChapter(server, syosetuTitle), dirty: false })
      pulledChapters++
    }
  }

  recomputePending()
  return { ok: true, pulledSyosetu, pulledChapters }
}

export async function syncNow(): Promise<{ ok: boolean; result?: SyncResult; error?: string }> {
  if (state.status === "syncing") {
    return { ok: false, error: "すでに同期中です" }
  }
  setState({ status: "syncing", lastError: null })
  const startedAt = Date.now()

  const push = await pushDirty()
  if (!push.ok) {
    const errorMsg = push.error ?? "pushに失敗しました"
    setState({ status: "error", lastError: errorMsg })
    return { ok: false, error: errorMsg }
  }

  const pull = await pullSnapshot()
  if (!pull.ok) {
    const errorMsg = pull.error ?? "pullに失敗しました"
    setState({ status: "error", lastError: errorMsg })
    return { ok: false, error: errorMsg }
  }

  const result: SyncResult = {
    pushedSyosetu: push.pushedSyosetu,
    pushedChapters: push.pushedChapters,
    pulledSyosetu: pull.pulledSyosetu,
    pulledChapters: pull.pulledChapters,
    serverWinsSyosetu: push.serverWinsSyosetu,
    serverWinsChapters: push.serverWinsChapters,
    clientWinsSyosetu: push.pushedSyosetu,
    clientWinsChapters: push.pushedChapters,
    startedAt,
    finishedAt: Date.now(),
  }
  setState({
    status: "idle",
    lastSyncAt: Date.now(),
    lastResult: result,
    lastError: null,
  })
  return { ok: true, result }
}

let autoPushInFlight = false

export async function autoPushOnNavigate(): Promise<void> {
  if (autoPushInFlight) return
  if (state.status === "syncing") return
  if (pendingPushCount() === 0) {
    recomputePending()
    return
  }
  autoPushInFlight = true
  setState({ status: "syncing" })
  try {
    const push = await pushDirty()
    if (!push.ok) {
      setState({ status: "error", lastError: push.error ?? "pushに失敗しました" })
    } else {
      setState({ status: "idle", lastError: null })
    }
  } finally {
    autoPushInFlight = false
  }
}

export function noteLocalChange(): void {
  recomputePending()
}
