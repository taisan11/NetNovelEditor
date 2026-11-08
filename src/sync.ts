import {
  listDirtySyosetu,
  listDirtyChapters,
  listAllSyosetuIncludingDirty,
  listAllChapters,
  isCurrentRecord,
  markSyosetuClean,
  markChapterClean,
  setSyosetu,
  setChapter,
  removeAcknowledgedTombstones,
  pendingPushCount,
  type Syosetu,
  type Chapter,
} from "./storage";
import { acceptSettings, getPendingSettings, getSettingsRecord, type SettingsRecord } from "./settings";
import { subscribeLocalChanges } from "./localChanges";
import type { PlanInfo } from "../shared/plans";

export type SyncStatus = "idle" | "syncing" | "error";

export interface SyncState {
  status: SyncStatus;
  lastSyncAt: number | null;
  lastError: string | null;
  pendingPush: number;
  lastResult: SyncResult | null;
  plan: PlanInfo | null;
}

export interface SyncResult {
  uploadRequestSent: boolean;
  deleteRequestsSent: number;
  downloadRequestSent: boolean;
  pushedSyosetu: number;
  pushedChapters: number;
  pulledSyosetu: number;
  pulledChapters: number;
  serverWinsSyosetu: number;
  serverWinsChapters: number;
  clientWinsSyosetu: number;
  clientWinsChapters: number;
  startedAt: number;
  finishedAt: number;
}

const LAST_SYNC_KEY = "netnoveleditor_last_sync_v1";
let syncAccountId: string | null = null;
let accountVersion = 0;

const AUTH_CACHE_MS = 5 * 60_000;
const REMOTE_FRESH_MS = 60_000;
const MIN_SYNC_GAP_MS = 5_000;
const POLL_MIN_MS = 90_000;
const POLL_MAX_MS = 15 * 60_000;
const EDIT_DEBOUNCE_MS = 2_000;
const EDIT_MAX_WAIT_MS = 15_000;
let authCheckedAt: number | null = null;
let lastSuccessfulCheckAt: number | null = null;
let lastAttemptAt: number | null = null;
let pollInterval = POLL_MIN_MS;
let failures = 0;
let retryAt = 0;
let dirtySince: number | null = null;
let dirtyDueAt: number | null = null;
const scheduleListeners = new Set<() => void>();

function reschedule(): void {
  for (const listener of scheduleListeners) listener();
}

function lastSyncStorageKey(): string {
  return `${LAST_SYNC_KEY}_${encodeURIComponent(syncAccountId ?? "anonymous")}`;
}

function loadLastSyncAt(): number | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(lastSyncStorageKey());
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function saveLastSyncAt(value: number): void {
  if (typeof localStorage === "undefined" || syncAccountId === null) return;
  localStorage.setItem(lastSyncStorageKey(), String(value));
}

const LISTENERS = new Set<(state: SyncState) => void>();

let state: SyncState = {
  status: "idle",
  lastSyncAt: null,
  lastError: null,
  pendingPush: 0,
  lastResult: null,
  plan: null,
};

export function setSyncAccount(accountId: string | null): void {
  if (accountId !== null) authCheckedAt = Date.now();
  if (syncAccountId === accountId) return;
  syncAccountId = accountId;
  accountVersion++;
  authCheckedAt = accountId === null ? null : Date.now();
  lastSuccessfulCheckAt = null;
  lastAttemptAt = null;
  pollInterval = POLL_MIN_MS;
  failures = 0;
  retryAt = 0;
  dirtySince = dirtyDueAt = null;
  setState({ status: "idle", lastSyncAt: accountId ? loadLastSyncAt() : null, lastError: null, lastResult: null, plan: null });
  recomputePending();
  reschedule();
}

function emit(): void {
  for (const fn of LISTENERS) fn(state);
}

function setState(patch: Partial<SyncState>): void {
  state = { ...state, ...patch };
  emit();
}

function recomputePending(): void {
  const pending = pendingPushCount() + (getPendingSettings(syncAccountId) ? 1 : 0);
  if (state.pendingPush !== pending) {
    setState({ pendingPush: pending });
  }
}

export function hasPendingPush(): boolean {
  return pendingPushCount() > 0 || getPendingSettings(syncAccountId) !== null;
}

export function getSyncState(): SyncState {
  recomputePending();
  return state;
}

export function subscribeSync(fn: (s: SyncState) => void): () => void {
  LISTENERS.add(fn);
  fn(state);
  return () => {
    LISTENERS.delete(fn);
  };
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const res = await fetch(url, {
      ...init,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    if (!res.ok) {
      if (res.status === 401) authCheckedAt = null;
      let msg = `HTTP ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data?.error) msg = data.error;
      } catch {}
      return { ok: false, status: res.status, error: msg };
    }
    const data = (await res.json()) as T;
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface ServerSyosetu {
  id: string;
  title: string;
  pages: number;
  plot: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

interface ServerChapter {
  id: string;
  syosetuId: string;
  title: string;
  page: number;
  honbun: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

interface SnapshotResponse {
  syosetu: ServerSyosetu[];
  chapters: ServerChapter[];
  serverTime: number;
  settings?: SettingsRecord | null;
  plan?: PlanInfo;
}

interface PushResultEntry {
  id: string;
  winner: "client" | "server";
  server?: ServerSyosetu | ServerChapter;
}

interface PushResponse {
  ok: boolean;
  results: {
    syosetu: PushResultEntry[];
    chapters: PushResultEntry[];
  };
  settings?: SettingsRecord;
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
  };
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
    honbunClearRequested: false,
  };
}

export interface PushDirtyResult {
  ok: boolean;
  uploadRequestSent: boolean;
  deleteRequestsSent: number;
  pushedSyosetu: number;
  pushedChapters: number;
  serverWinsSyosetu: number;
  serverWinsChapters: number;
  error?: string;
  errorStatus?: number;
}

export async function uploadSync(): Promise<PushDirtyResult> {
  const accountId = syncAccountId;
  const version = accountVersion;
  const settings = getPendingSettings(accountId);
  const dirtyS = listDirtySyosetu();
  const dirtyC = listDirtyChapters();
  const deletedS = dirtyS.filter((s) => s.deleted);
  const deletedC = dirtyC.filter((c) => c.deleted);
  const liveS = dirtyS.filter((s) => !s.deleted);
  const liveC = dirtyC.filter((c) => !c.deleted);
  const result: PushDirtyResult = {
    ok: true,
    uploadRequestSent: false,
    deleteRequestsSent: 0,
    pushedSyosetu: 0,
    pushedChapters: 0,
    serverWinsSyosetu: 0,
    serverWinsChapters: 0,
  };
  // Usually preferences share the novel request. Retry them separately only if
  // the novel batch is rejected (e.g. quota), so they can still be synchronized.
  const saveSettings = async (): Promise<{ error: string; errorStatus?: number } | null> => {
    if (!settings || !accountId) return null;
    result.uploadRequestSent = true;
    const saved = await fetchJson<PushResponse>("/api/sync/push", {
      method: "POST",
      body: JSON.stringify({ syosetu: [], chapters: [], settings }),
    });
    if (!saved.ok || version !== accountVersion) {
      return !saved.ok
        ? { error: saved.error, errorStatus: saved.status }
        : { error: "同期中にアカウントが変更されました" };
    }
    if (saved.data.settings) acceptSettings(saved.data.settings, accountId, settings);
    return null;
  };

  // Deletions use dedicated idempotent endpoints. Keep each local tombstone
  // until its request succeeds so offline deletes can be retried safely.
  const deletedParents = new Set<string>();
  for (const [kind, records] of [
    ["syosetu", deletedS],
    ["chapter", deletedC],
  ] as const) {
    for (const record of records) {
      if (kind === "chapter" && deletedParents.has((record as Chapter).syosetuId)) continue;
      const deleted = await fetchJson<{ ok: boolean }>(
        `/api/sync/${kind}/${encodeURIComponent(record.id)}`,
        { method: "DELETE" },
      );
      if (!deleted.ok || version !== accountVersion) {
        return {
          ...result,
          ok: false,
          error: !deleted.ok ? deleted.error : "同期中にアカウントが変更されました",
          errorStatus: !deleted.ok ? deleted.status : undefined,
        };
      }
      result.deleteRequestsSent++;
      if (kind === "syosetu") {
        // The work endpoint already deletes its chapters in one transaction.
        deletedParents.add(record.id);
        const children = deletedC.filter((c) => c.syosetuId === record.id);
        result.pushedSyosetu++;
        result.pushedChapters += children.length;
        removeAcknowledgedTombstones([record as Syosetu], children);
      } else {
        result.pushedChapters++;
        removeAcknowledgedTombstones([], [record as Chapter]);
      }
    }
  }

  if (liveS.length === 0 && liveC.length === 0) {
    const error = await saveSettings();
    recomputePending();
    return error ? { ...result, ok: false, ...error } : result;
  }

  result.uploadRequestSent = true;
  const res = await fetchJson<PushResponse>("/api/sync/push", {
    method: "POST",
    body: JSON.stringify({
      ...(settings && accountId ? { settings } : {}),
      syosetu: liveS.map((s) => ({
        id: s.id,
        title: s.title,
        pages: s.pages,
        plot: s.plot,
        createdAt: s.updatedAt,
        updatedAt: s.updatedAt,
        deleted: false,
      })),
      chapters: liveC.map((c) => ({
        id: c.id,
        syosetuId: c.syosetuId,
        title: c.title,
        page: c.page,
        honbun: c.honbun,
        allowEmptyHonbun: c.honbunClearRequested === true,
        createdAt: c.updatedAt,
        updatedAt: c.updatedAt,
        deleted: false,
      })),
    }),
  });

  if (!res.ok) {
    if (version === accountVersion && (res.status === 403 || res.status === 413)) {
      await saveSettings();
    }
    recomputePending();
    return { ...result, ok: false, error: res.error, errorStatus: res.status };
  }

  if (version !== accountVersion) {
    return {
      ...result,
      ok: false,
      pushedSyosetu: 0,
      pushedChapters: 0,
      error: "同期中にアカウントが変更されました",
    };
  }

  const sentSyosetu = new Map(liveS.map((s) => [s.id, s]));
  const sentChapters = new Map(liveC.map((c) => [c.id, c]));
  if (settings && accountId && res.data.settings) acceptSettings(res.data.settings, accountId, settings);

  for (const r of res.data.results.syosetu) {
    const sent = sentSyosetu.get(r.id);
    if (!sent || !isCurrentRecord(sent)) continue;
    if (r.winner === "client") {
      markSyosetuClean(r.id);
      result.pushedSyosetu++;
    } else if (r.winner === "server" && r.server) {
      setSyosetu(toClientSyosetu(r.server as ServerSyosetu));
      result.serverWinsSyosetu++;
    }
  }
  for (const r of res.data.results.chapters) {
    const sent = sentChapters.get(r.id);
    if (!sent || !isCurrentRecord(sent)) continue;
    if (r.winner === "client") {
      markChapterClean(r.id);
      result.pushedChapters++;
    } else if (r.winner === "server" && r.server) {
      const server = r.server as ServerChapter;
      setChapter(toClientChapter(server, sent.Syosetu_title));
      result.serverWinsChapters++;
    }
  }

  recomputePending();
  return result;
}

export interface PullResult {
  ok: boolean;
  pulledSyosetu: number;
  pulledChapters: number;
  serverTime?: number;
  error?: string;
}

function shouldApplyServerRecord(
  server: ServerSyosetu | ServerChapter,
  local: Syosetu | Chapter | undefined,
): boolean {
  return !local?.dirty && (local ? server.updatedAt > local.updatedAt : !server.deleted);
}

export async function downloadSync(): Promise<PullResult> {
  const accountId = syncAccountId;
  const version = accountVersion;
  // updatedAt originates on client devices, so it cannot safely serve as a
  // server-side change cursor (clock skew and delayed uploads can hide rows).
  const res = await fetchJson<SnapshotResponse>("/api/sync/snapshot");
  if (!res.ok) {
    return { ok: false, pulledSyosetu: 0, pulledChapters: 0, error: res.error };
  }
  if (version !== accountVersion) {
    return {
      ok: false,
      pulledSyosetu: 0,
      pulledChapters: 0,
      error: "同期中にアカウントが変更されました",
    };
  }
  if (!Number.isFinite(res.data.serverTime) || res.data.serverTime < 0) {
    return {
      ok: false,
      pulledSyosetu: 0,
      pulledChapters: 0,
      error: "サーバー時刻を取得できませんでした",
    };
  }

  const localSyosetu = new Map(listAllSyosetuIncludingDirty().map((s) => [s.id, s]));
  const localChapters = new Map(listAllChapters().map((c) => [c.id, c]));
  const titleBySyosetuId = new Map<string, string>();
  for (const s of localSyosetu.values()) {
    if (!s.deleted) titleBySyosetuId.set(s.id, s.title);
  }

  let pulledSyosetu = 0;
  let pulledChapters = 0;

  for (const server of res.data.syosetu) {
    const local = localSyosetu.get(server.id);
    // A save or backup import may have happened while the request was in flight.
    // Never replace an unsent local version during the download phase.
    if (!shouldApplyServerRecord(server, local)) continue;
    setSyosetu(toClientSyosetu(server));
    if (!server.deleted) titleBySyosetuId.set(server.id, server.title);
    pulledSyosetu++;
  }

  for (const server of res.data.chapters) {
    const local = localChapters.get(server.id);
    if (!shouldApplyServerRecord(server, local)) continue;
    const syosetuTitle = titleBySyosetuId.get(server.syosetuId) ?? local?.Syosetu_title ?? "";
    if (!syosetuTitle) continue;

    setChapter(toClientChapter(server, syosetuTitle));
    pulledChapters++;
  }

  saveLastSyncAt(res.data.serverTime);
  if (accountId && res.data.settings) acceptSettings(res.data.settings, accountId);
  setState({ lastSyncAt: res.data.serverTime, plan: res.data.plan ?? state.plan });
  recomputePending();
  return { ok: true, pulledSyosetu, pulledChapters, serverTime: res.data.serverTime };
}

export async function syncNow(): Promise<{ ok: boolean; result?: SyncResult; error?: string }> {
  if (syncInFlight) return syncInFlight;
  const version = accountVersion;
  const hadPending = hasPendingPush();
  const settingsRevision = getSettingsRecord()?.updatedAt;
  lastAttemptAt = Date.now();
  const run = runFullSync().catch((err: unknown) => {
    const error = err instanceof Error ? err.message : String(err);
    if (version === accountVersion) setState({ status: "error", lastError: error });
    return { ok: false as const, error };
  });
  syncInFlight = run;
  try {
    const outcome = await run;
    if (version === accountVersion) {
      if (outcome.ok) {
        lastSuccessfulCheckAt = Date.now();
        failures = 0;
        retryAt = 0;
        const result = outcome.result;
        const changed = hadPending || settingsRevision !== getSettingsRecord()?.updatedAt ||
          (result && result.pulledSyosetu + result.pulledChapters > 0);
        pollInterval = changed ? POLL_MIN_MS : Math.min(POLL_MAX_MS, pollInterval * 2);
        if (!hasPendingPush()) dirtySince = dirtyDueAt = null;
      } else {
        failures++;
        retryAt = Date.now() + Math.min(POLL_MAX_MS, 30_000 * 2 ** Math.min(failures - 1, 5));
      }
    }
    return outcome;
  } finally {
    if (syncInFlight === run) syncInFlight = null;
    reschedule();
  }
}

let syncInFlight: Promise<{ ok: boolean; result?: SyncResult; error?: string }> | null = null;

async function runFullSync(): Promise<{ ok: boolean; result?: SyncResult; error?: string }> {
  const version = accountVersion;
  setState({ status: "syncing", lastError: null });
  const startedAt = Date.now();

  const push = await uploadSync();
  if (version !== accountVersion) return { ok: false, error: "同期中にアカウントが変更されました" };
  if (!push.ok) {
    // Quotas must not prevent reading cloud data. But an unreachable server or
    // expired session does not need another request that will fail the same way.
    if (push.errorStatus !== 0 && push.errorStatus !== 401) await downloadSync();
    if (version !== accountVersion) return { ok: false, error: "同期中にアカウントが変更されました" };
    const errorMsg = push.error ?? "uploadに失敗しました";
    setState({ status: "error", lastError: errorMsg });
    return { ok: false, error: errorMsg };
  }

  const pull = await downloadSync();
  if (version !== accountVersion) return { ok: false, error: "同期中にアカウントが変更されました" };
  if (!pull.ok) {
    const errorMsg = pull.error ?? "pullに失敗しました";
    setState({ status: "error", lastError: errorMsg });
    return { ok: false, error: errorMsg };
  }

  const result: SyncResult = {
    uploadRequestSent: push.uploadRequestSent,
    deleteRequestsSent: push.deleteRequestsSent,
    downloadRequestSent: true,
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
  };
  setState({
    status: "idle",
    lastResult: result,
    lastError: null,
  });
  return { ok: true, result };
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export async function autoSyncOnNavigate(): Promise<void> {
  if (syncAccountId !== null) await autoSyncNow();
}

async function syncIfNeeded(): Promise<void> {
  if (syncAccountId === null || cannotAutoSync()) return;
  const now = Date.now();
  if (now < retryAt || (lastAttemptAt !== null && now - lastAttemptAt < MIN_SYNC_GAP_MS)) return;
  if (!hasPendingPush() && lastSuccessfulCheckAt !== null && now - lastSuccessfulCheckAt < REMOTE_FRESH_MS) return;
  await syncNow();
}

let autoSyncInFlight: Promise<void> | null = null;

function cannotAutoSync(): boolean {
  return isOffline() || (typeof document !== "undefined" && document.visibilityState === "hidden");
}

export async function autoSyncNow(): Promise<void> {
  if (autoSyncInFlight) return autoSyncInFlight;
  if (cannotAutoSync() || Date.now() < retryAt) return;
  const version = accountVersion;
  const run = (async () => {
    if (authCheckedAt === null || Date.now() - authCheckedAt >= AUTH_CACHE_MS) {
      const res = await fetchJson<{ user: { id: string } | null }>("/api/auth/me");
      if (version !== accountVersion) return;
      if (!res.ok) {
        failures++;
        retryAt = Date.now() + Math.min(POLL_MAX_MS, 30_000 * 2 ** Math.min(failures - 1, 5));
        return;
      }
      setSyncAccount(res.data.user?.id ?? null);
      authCheckedAt = Date.now();
      if (syncAccountId === null) {
        failures = 0;
        retryAt = 0;
      }
    }
    await syncIfNeeded();
  })();
  autoSyncInFlight = run;
  try {
    await run;
  } finally {
    if (autoSyncInFlight === run) autoSyncInFlight = null;
    reschedule();
  }
}

// One adaptive timer batches edits and backs off quiet or failing connections.
// Wake-up events share the same freshness/cooldown checks as route changes.
export function startAutoSync(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (stopped || cannotAutoSync()) return;
    const now = Date.now();
    let dueAt: number;
    if (syncAccountId === null) {
      dueAt = authCheckedAt === null ? now : authCheckedAt + AUTH_CACHE_MS;
    } else if (hasPendingPush()) {
      dueAt = dirtyDueAt ?? now + EDIT_DEBOUNCE_MS;
    } else {
      dueAt = lastSuccessfulCheckAt === null ? now : lastSuccessfulCheckAt + pollInterval;
    }
    dueAt = Math.max(dueAt, retryAt, (lastAttemptAt ?? -MIN_SYNC_GAP_MS) + MIN_SYNC_GAP_MS);
    timer = setTimeout(() => {
      timer = null;
      dirtySince = dirtyDueAt = null;
      run();
    }, Math.max(0, dueAt - now));
  };
  const run = () => {
    if (!stopped) void autoSyncNow().finally(schedule);
  };
  scheduleListeners.add(schedule);
  window.addEventListener("focus", run);
  window.addEventListener("online", run);
  document.addEventListener("visibilitychange", run);
  run();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    scheduleListeners.delete(schedule);
    window.removeEventListener("focus", run);
    window.removeEventListener("online", run);
    document.removeEventListener("visibilitychange", run);
  };
}

export function noteLocalChange(): void {
  recomputePending();
  if (hasPendingPush()) {
    const now = Date.now();
    dirtySince ??= now;
    dirtyDueAt = Math.min(now + EDIT_DEBOUNCE_MS, dirtySince + EDIT_MAX_WAIT_MS);
  } else {
    dirtySince = dirtyDueAt = null;
  }
  reschedule();
}

subscribeLocalChanges(noteLocalChange);
