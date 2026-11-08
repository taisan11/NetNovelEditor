import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as storage from "../src/storage";
import {
  autoSyncNow,
  autoSyncOnNavigate,
  downloadSync,
  getSyncState,
  setSyncAccount,
  startAutoSync,
  subscribeSync,
  syncNow,
  uploadSync,
} from "../src/sync";
import { resetStorage, seedRecords } from "./helpers";
import { createSyncClock } from "./sync-clock";
import { setSettings } from "../src/settings";

const originalFetch = globalThis.fetch;
beforeEach(() => {
  resetStorage();
  setSyncAccount("reset-account");
  setSyncAccount(null);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("an edit made during upload stays dirty", async () => {
  const work = storage.setSyosetu({
    id: "race-work",
    title: "race-work",
    pages: 0,
    plot: "old",
    updatedAt: 1,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    storage.setSyosetu({ ...work, plot: "new", updatedAt: 2 });
    return Response.json({
      ok: true,
      results: { syosetu: [{ id: work.id, winner: "client" }], chapters: [] },
    });
  }) as typeof fetch;
  try {
    await uploadSync();
    expect(storage.getSyosetu(work.title)?.plot).toBe("new");
    expect(storage.getSyosetu(work.title)?.dirty).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deletions created during upload are not discarded", async () => {
  const work = storage.setSyosetu({
    id: "delete-work",
    title: "delete-work",
    pages: 0,
    plot: "",
    updatedAt: 10,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    storage.deleteSyosetu(work.title);
    return Response.json({
      ok: true,
      results: { syosetu: [{ id: work.id, winner: "client" }], chapters: [] },
    });
  }) as typeof fetch;
  try {
    await uploadSync();
    expect(storage.listDirtySyosetu().some((s) => s.id === work.id && s.deleted)).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("download requests a full snapshot and preserves newer local deletion", async () => {
  const work = storage.setSyosetu({
    id: "pull-work",
    title: "pull-work",
    pages: 0,
    plot: "",
    updatedAt: 10,
  });
  storage.deleteSyosetu(work.title);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("/api/sync/snapshot");
    return Response.json({
      serverTime: Date.now(),
      syosetu: [{ ...work, createdAt: 1, deleted: true }],
      chapters: [],
    });
  }) as typeof fetch;
  try {
    await downloadSync();
    expect(storage.listDirtySyosetu().some((s) => s.id === work.id && s.deleted)).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deleting an already dirty chapter retains its pending count", () => {
  const work = storage.setSyosetu({ id: "count-work", title: "count-work", pages: 1, plot: "" });
  storage.setChapter({
    id: "count-chapter",
    syosetuId: work.id,
    Syosetu_title: work.title,
    title: "chapter",
    page: 1,
    honbun: "text",
  });
  const before = storage.pendingPushCount();
  storage.deleteChapter(work.title, 1);
  expect(storage.pendingPushCount()).toBe(before);
});

test("editing synchronized text, plot and page count sends fresh versions", async () => {
  const { work, chapter } = seedRecords();
  storage.saveChapter({ ...chapter, honbun: "edited text" });
  storage.saveSyosetu({ ...work, plot: "edited plot", pages: 2 });
  const calls: string[] = [];
  globalThis.fetch = mock(async (input, init) => {
    calls.push(String(input));
    const body = JSON.parse(String(init?.body));
    expect(body.chapters[0].honbun).toBe("edited text");
    expect(body.chapters[0].updatedAt).toBeGreaterThan(chapter.updatedAt);
    expect(body.syosetu[0].plot).toBe("edited plot");
    expect(body.syosetu[0].pages).toBe(2);
    expect(body.syosetu[0].updatedAt).toBeGreaterThan(work.updatedAt);
    return Response.json({
      results: {
        syosetu: [{ id: work.id, winner: "client" }],
        chapters: [{ id: chapter.id, winner: "client" }],
      },
    });
  }) as typeof fetch;
  expect((await uploadSync()).ok).toBe(true);
  expect(calls).toEqual(["/api/sync/push"]);
  expect(storage.pendingPushCount()).toBe(0);
});

test("restoring a synchronized backup uploads it including an intentional empty body", async () => {
  const { work, chapter } = seedRecords();
  storage.importBackup(
    JSON.stringify({ version: 1, works: [work], chapters: [{ ...chapter, honbun: "" }] }),
  );
  expect(storage.pendingPushCount()).toBe(2);
  globalThis.fetch = mock(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.syosetu[0].updatedAt).toBeGreaterThan(work.updatedAt);
    expect(body.chapters[0].updatedAt).toBeGreaterThan(chapter.updatedAt);
    expect(body.chapters[0].allowEmptyHonbun).toBe(true);
    return Response.json({
      results: {
        syosetu: [{ id: work.id, winner: "client" }],
        chapters: [{ id: chapter.id, winner: "client" }],
      },
    });
  }) as typeof fetch;
  expect((await uploadSync()).ok).toBe(true);
  expect(storage.pendingPushCount()).toBe(0);
});

test("download does not overwrite edits saved while the request is in flight", async () => {
  const { work, chapter } = seedRecords();
  globalThis.fetch = mock(async () => {
    storage.saveChapter({ ...chapter, honbun: "unsent edit" });
    storage.saveSyosetu({ ...work, plot: "unsent plot" });
    return Response.json({
      serverTime: Date.now(),
      syosetu: [{ ...work, createdAt: 1, updatedAt: Date.now() + 100_000 }],
      chapters: [{ ...chapter, createdAt: 1, updatedAt: Date.now() + 100_000 }],
    });
  }) as typeof fetch;
  expect((await downloadSync()).ok).toBe(true);
  expect(storage.getChapterById(chapter.id)?.honbun).toBe("unsent edit");
  expect(storage.getSyosetuById(work.id)?.plot).toBe("unsent plot");
  expect(storage.pendingPushCount()).toBe(2);
});

test("a backup imported during download is preserved", async () => {
  const { work, chapter } = seedRecords();
  globalThis.fetch = mock(async () => {
    storage.importBackup(
      JSON.stringify({ version: 1, works: [work], chapters: [{ ...chapter, honbun: "restored" }] }),
    );
    return Response.json({
      serverTime: Date.now(),
      syosetu: [{ ...work, createdAt: 1, updatedAt: Date.now() + 100_000 }],
      chapters: [{ ...chapter, createdAt: 1, updatedAt: Date.now() + 100_000 }],
    });
  }) as typeof fetch;
  await downloadSync();
  expect(storage.getChapterById(chapter.id)?.honbun).toBe("restored");
  expect(storage.pendingPushCount()).toBe(2);
});

test("automatic sync downloads even with no pending uploads", async () => {
  const { work, chapter } = seedRecords();
  setSyncAccount("account");
  const calls: string[] = [];
  globalThis.fetch = mock(async (input) => {
    calls.push(String(input));
    return Response.json({
      serverTime: 200,
      syosetu: [{ ...work, createdAt: 1, updatedAt: 200 }],
      chapters: [{ ...chapter, createdAt: 1, honbun: "other device", updatedAt: 200 }],
    });
  }) as typeof fetch;
  await autoSyncOnNavigate();
  expect(calls).toEqual(["/api/sync/snapshot"]);
  expect(storage.getChapterById(chapter.id)?.honbun).toBe("other device");
  expect(getSyncState().status).toBe("idle");
});

test("startup authenticates before automatically downloading", async () => {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input) => {
    calls.push(String(input));
    return Response.json(
      String(input) === "/api/auth/me"
        ? { user: { id: "startup-account" } }
        : { serverTime: 200, syosetu: [], chapters: [] },
    );
  }) as typeof fetch;
  await autoSyncNow();
  expect(calls).toEqual(["/api/auth/me", "/api/sync/snapshot"]);
});

test("automatic sync does not send data when signed out", async () => {
  const { chapter } = seedRecords();
  storage.saveChapter({ ...chapter, honbun: "unsent" });
  globalThis.fetch = mock(async () => Response.json({ user: null })) as typeof fetch;
  await autoSyncOnNavigate();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await autoSyncNow();
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

test("automatic sync skips offline devices without losing pending edits", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
  const { chapter } = seedRecords();
  storage.saveChapter({ ...chapter, honbun: "offline edit" });
  setSyncAccount("account");
  globalThis.fetch = mock(async () => {
    throw new Error("must not fetch");
  }) as typeof fetch;
  try {
    await autoSyncNow();
    await autoSyncOnNavigate();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(storage.pendingPushCount()).toBe(1);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("sync indicator state covers the request and concurrent syncs share one download", async () => {
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  globalThis.fetch = mock(() => response) as typeof fetch;
  const statuses: string[] = [];
  const unsubscribe = subscribeSync((s) => statuses.push(s.status));
  try {
    const first = syncNow();
    const second = syncNow();
    expect(getSyncState().status).toBe("syncing");
    resolveResponse(Response.json({ serverTime: 200, syosetu: [], chapters: [] }));
    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(statuses).toContain("syncing");
    expect(statuses.at(-1)).toBe("idle");
  } finally {
    unsubscribe();
  }
});

test("failed downloads clear the syncing indicator and allow retry", async () => {
  globalThis.fetch = mock(async () => {
    throw new Error("offline");
  }) as typeof fetch;
  expect((await syncNow()).ok).toBe(false);
  expect(getSyncState().status).toBe("error");
  globalThis.fetch = mock(async () =>
    Response.json({ serverTime: 200, syosetu: [], chapters: [] }),
  ) as typeof fetch;
  expect((await syncNow()).ok).toBe(true);
  expect(getSyncState().status).toBe("idle");
});

test("storage exceptions clear the syncing indicator", async () => {
  setSyncAccount("account");
  const memory = localStorage as ReturnType<typeof resetStorage>;
  memory.failWrite = (key) => key.startsWith("netnoveleditor_last_sync_");
  globalThis.fetch = mock(async () =>
    Response.json({ serverTime: 200, syosetu: [], chapters: [] }),
  ) as typeof fetch;
  expect((await syncNow()).ok).toBe(false);
  expect(getSyncState().status).toBe("error");
});

test("responses from a previous account are ignored", async () => {
  const { work, chapter } = seedRecords();
  setSyncAccount("old-account");
  globalThis.fetch = mock(async () => {
    setSyncAccount("new-account");
    return Response.json({
      serverTime: 200,
      syosetu: [{ ...work, createdAt: 1, updatedAt: 200 }],
      chapters: [{ ...chapter, createdAt: 1, honbun: "wrong account", updatedAt: 200 }],
    });
  }) as typeof fetch;
  expect((await downloadSync()).ok).toBe(false);
  expect(storage.getChapterById(chapter.id)?.honbun).toBe(chapter.honbun);
});

test("automatic sync registers wake-up events and polling and removes them on cleanup", async () => {
  const clock = createSyncClock();
  globalThis.fetch = mock(async (input) =>
    Response.json(
      String(input) === "/api/auth/me"
        ? { user: { id: "account" } }
        : { serverTime: 200, syosetu: [], chapters: [] },
    ),
  ) as typeof fetch;
  let stop: (() => void) | undefined;
  try {
    stop = startAutoSync();
    await autoSyncNow();
    clock.window.dispatchEvent(new Event("focus"));
    clock.window.dispatchEvent(new Event("online"));
    clock.document.dispatchEvent(new Event("visibilitychange"));
    await autoSyncNow();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(clock.nextDelay()).toBe(180_000);
    await clock.advance(180_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3); // Cached authentication.
    Object.assign(clock.document, { visibilityState: "hidden" });
    clock.document.dispatchEvent(new Event("visibilitychange"));
    await clock.settle();
    const before = (globalThis.fetch as ReturnType<typeof mock>).mock.calls.length;
    await clock.advance(1_000_000);
    expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(before);
    expect(clock.pendingTimers()).toBe(0);
    Object.assign(clock.document, { visibilityState: "visible" });
    clock.document.dispatchEvent(new Event("visibilitychange"));
    await autoSyncNow();
    expect(globalThis.fetch).toHaveBeenCalledTimes(before + 2); // Expired auth + snapshot.
    stop();
    await clock.advance(1_000_000);
    clock.window.dispatchEvent(new Event("focus"));
    clock.window.dispatchEvent(new Event("online"));
    clock.document.dispatchEvent(new Event("visibilitychange"));
    await clock.settle();
    expect(globalThis.fetch).toHaveBeenCalledTimes(before + 2);
    expect(clock.pendingTimers()).toBe(0);
  } finally {
    stop?.();
    clock.restore();
  }
});

test.each(["client", "server"] as const)(
  "chapter edits during upload survive a %s winner",
  async (winner) => {
    const { work, chapter } = seedRecords();
    const sent = storage.saveChapter({ ...chapter, honbun: "sent" });
    globalThis.fetch = mock(async () => {
      storage.saveChapter({ ...sent, honbun: "saved during upload" });
      return Response.json({
        results: {
          syosetu: [],
          chapters: [
            {
              id: chapter.id,
              winner,
              server: { ...chapter, createdAt: 1, updatedAt: Date.now() + 100_000 },
            },
          ],
        },
      });
    }) as typeof fetch;
    expect((await uploadSync()).pushedChapters).toBe(0);
    expect(storage.getChapterById(chapter.id)?.honbun).toBe("saved during upload");
    expect(storage.listChapters(work.title)[0]?.honbun).toBe("saved during upload");
    expect(storage.pendingPushCount()).toBe(1);
  },
);

test("duplicate and unknown upload results are ignored after acknowledging the exact version", async () => {
  const { work, chapter } = seedRecords();
  storage.saveSyosetu({ ...work, plot: "edited" });
  storage.saveChapter({ ...chapter, honbun: "edited" });
  const entries = (id: string) => [
    { id, winner: "client" },
    { id, winner: "client" },
    { id: "unknown", winner: "client" },
  ];
  globalThis.fetch = mock(async () =>
    Response.json({
      results: {
        syosetu: entries(work.id),
        chapters: entries(chapter.id),
      },
    }),
  ) as typeof fetch;
  const result = await uploadSync();
  expect(result.pushedSyosetu).toBe(1);
  expect(result.pushedChapters).toBe(1);
  expect(storage.pendingPushCount()).toBe(0);
});

test("work deletion acknowledges child tombstones with just one request", async () => {
  const { work, chapter } = seedRecords();
  storage.deleteSyosetu(work.title);
  const calls: string[] = [];
  globalThis.fetch = mock(async (input, init) => {
    calls.push(String(input));
    expect(init?.method).toBe("DELETE");
    return String(input).includes("/chapter/")
      ? Response.json({ error: "retry later" }, { status: 500 })
      : Response.json({ ok: true });
  }) as typeof fetch;
  expect(await uploadSync()).toMatchObject({
    ok: true,
    deleteRequestsSent: 1,
    pushedSyosetu: 1,
    pushedChapters: 1,
  });
  expect(calls).toEqual([`/api/sync/syosetu/${work.id}`]);
  expect(storage.pendingPushCount()).toBe(0);
  expect(storage.listAllSyosetuIncludingDirty()).toEqual([]);
  expect(storage.listAllChapters()).toEqual([]);
});

test("a failed standalone chapter deletion retains its tombstone for retry", async () => {
  const { work } = seedRecords();
  storage.deleteChapter(work.title, 1);
  globalThis.fetch = mock(async () => Response.json({ error: "retry later" }, { status: 500 })) as typeof fetch;
  expect(await uploadSync()).toMatchObject({ ok: false, deleteRequestsSent: 0, error: "retry later" });
  expect(storage.pendingPushCount()).toBe(1);
  globalThis.fetch = mock(async () => Response.json({ ok: true })) as typeof fetch;
  expect(await uploadSync()).toMatchObject({
    ok: true,
    uploadRequestSent: false,
    deleteRequestsSent: 1,
    pushedSyosetu: 0,
    pushedChapters: 1,
  });
  expect(storage.pendingPushCount()).toBe(0);
  expect(storage.listAllSyosetuIncludingDirty()).toHaveLength(1);
  expect(storage.listAllChapters()).toEqual([]);
});

test.each([
  { updatedAt: 99, deleted: false, dirty: false, applied: false },
  { updatedAt: 100, deleted: false, dirty: false, applied: false },
  { updatedAt: 101, deleted: false, dirty: false, applied: true },
  { updatedAt: 99, deleted: true, dirty: false, applied: false },
  { updatedAt: 100, deleted: true, dirty: false, applied: false },
  { updatedAt: 101, deleted: true, dirty: false, applied: true },
  { updatedAt: 101, deleted: false, dirty: true, applied: false },
  { updatedAt: 101, deleted: true, dirty: true, applied: false },
])(
  "download applies matching revision rules to works and chapters: %j",
  async ({ updatedAt, deleted, dirty, applied }) => {
    const { work, chapter } = seedRecords();
    if (dirty) {
      storage.setSyosetu({ ...work, dirty: true });
      storage.setChapter({ ...chapter, dirty: true });
    }
    globalThis.fetch = mock(async () =>
      Response.json({
        serverTime: 200,
        syosetu: [{ ...work, createdAt: 1, updatedAt, deleted, plot: "server" }],
        chapters: [{ ...chapter, createdAt: 1, updatedAt, deleted, honbun: "server" }],
      }),
    ) as typeof fetch;
    const result = await downloadSync();
    expect(result.pulledSyosetu).toBe(applied ? 1 : 0);
    expect(result.pulledChapters).toBe(applied ? 1 : 0);
    expect(storage.listAllSyosetuIncludingDirty()[0]?.plot).toBe(applied ? "server" : work.plot);
    expect(storage.listAllChapters()[0]?.honbun).toBe(applied ? "server" : chapter.honbun);
    expect(storage.pendingPushCount()).toBe(dirty ? 2 : 0);
  },
);

test("download creates live records but does not create unknown tombstones", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({
      serverTime: 200,
      syosetu: [
        {
          id: "live",
          title: "live",
          pages: 1,
          plot: "",
          createdAt: 1,
          updatedAt: 100,
          deleted: false,
        },
        {
          id: "deleted",
          title: "deleted",
          pages: 1,
          plot: "",
          createdAt: 1,
          updatedAt: 100,
          deleted: true,
        },
      ],
      chapters: [
        {
          id: "live-chapter",
          syosetuId: "live",
          title: "chapter",
          page: 1,
          honbun: "text",
          createdAt: 1,
          updatedAt: 100,
          deleted: false,
        },
        {
          id: "deleted-chapter",
          syosetuId: "live",
          title: "deleted chapter",
          page: 2,
          honbun: "",
          createdAt: 1,
          updatedAt: 100,
          deleted: true,
        },
      ],
    }),
  ) as typeof fetch;
  expect(await downloadSync()).toMatchObject({ ok: true, pulledSyosetu: 1, pulledChapters: 1 });
  expect(storage.listAllSyosetuIncludingDirty()).toHaveLength(1);
  expect(storage.listChapters("live")).toHaveLength(1);
  expect(storage.pendingPushCount()).toBe(0);
});

function mockSyncServer() {
  const fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/auth/me") return Response.json({ user: { id: "account" } });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      return Response.json({
        results: {
          syosetu: body.syosetu.map((s: { id: string }) => ({ id: s.id, winner: "client" })),
          chapters: body.chapters.map((c: { id: string }) => ({ id: c.id, winner: "client" })),
        },
        settings: body.settings,
      });
    }
    return Response.json({ serverTime: Date.now(), syosetu: [], chapters: [] });
  });
  globalThis.fetch = fetch as typeof globalThis.fetch;
  return fetch;
}

test("nearby route and wake events reuse a recent download; manual sync still forces a request", async () => {
  const clock = createSyncClock();
  setSyncAccount("account");
  const fetch = mockSyncServer();
  try {
    await autoSyncNow();
    await autoSyncOnNavigate();
    await autoSyncNow();
    expect(fetch).toHaveBeenCalledTimes(1);
    await clock.advance(59_999);
    await autoSyncOnNavigate();
    expect(fetch).toHaveBeenCalledTimes(1);
    await clock.advance(1);
    await autoSyncOnNavigate();
    expect(fetch).toHaveBeenCalledTimes(2);
    await syncNow();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([url]) => url === "/api/sync/snapshot")).toBe(true);
  } finally {
    clock.restore();
  }
});

test("automatic sync batches saved edits and settings into the latest upload", async () => {
  const clock = createSyncClock();
  const { work, chapter } = seedRecords();
  setSyncAccount("account");
  const fetch = mockSyncServer();
  const stop = startAutoSync();
  try {
    await clock.advance(5_000);
    storage.saveChapter({ ...chapter, honbun: "first" });
    await clock.advance(1_000);
    storage.saveChapter({ ...chapter, honbun: "latest" });
    storage.saveSyosetu({ ...work, plot: "latest plot" });
    setSettings({ fontSize: 20, lineHeight: 1.7, theme: "dark", verticalWriting: false });
    await clock.advance(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await clock.advance(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    const body = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(body.chapters[0].honbun).toBe("latest");
    expect(body.syosetu[0].plot).toBe("latest plot");
    expect(body.settings.values.theme).toBe("dark");
    expect(storage.pendingPushCount()).toBe(0);
    expect(clock.nextDelay()).toBe(90_000);
  } finally {
    stop();
    clock.restore();
  }
});

test("continuous saves cannot postpone uploading indefinitely", async () => {
  const clock = createSyncClock();
  const { chapter } = seedRecords();
  setSyncAccount("account");
  const fetch = mockSyncServer();
  const stop = startAutoSync();
  try {
    await clock.advance(5_000);
    storage.saveChapter({ ...chapter, honbun: "0" });
    for (let i = 1; i <= 14; i++) {
      await clock.advance(1_000);
      storage.saveChapter({ ...chapter, honbun: String(i) });
    }
    await clock.advance(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await clock.advance(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).chapters[0].honbun).toBe("14");
  } finally {
    stop();
    clock.restore();
  }
});

test("quiet polling backs off to fifteen minutes and resets after local changes", async () => {
  const clock = createSyncClock();
  const { chapter } = seedRecords();
  setSyncAccount("account");
  mockSyncServer();
  const stop = startAutoSync();
  try {
    await clock.settle();
    for (const delay of [180_000, 360_000, 720_000, 900_000, 900_000]) {
      expect(clock.nextDelay()).toBe(delay);
      await clock.advance(delay);
    }
    storage.saveChapter({ ...chapter, honbun: "changed" });
    await clock.advance(5_000);
    expect(storage.pendingPushCount()).toBe(0);
    expect(clock.nextDelay()).toBe(90_000);
  } finally {
    stop();
    clock.restore();
  }
});

test("failures back off even across focus events; manual retry bypasses the wait", async () => {
  const clock = createSyncClock();
  setSyncAccount("account");
  globalThis.fetch = mock(async () => Response.json({ error: "unavailable" }, { status: 503 })) as typeof fetch;
  const stop = startAutoSync();
  try {
    await clock.settle();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(clock.nextDelay()).toBe(30_000);
    clock.window.dispatchEvent(new Event("focus"));
    await autoSyncNow();
    await autoSyncOnNavigate();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await clock.advance(30_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    expect(clock.nextDelay()).toBe(60_000);
    expect((await syncNow()).ok).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(clock.nextDelay()).toBe(120_000);
    const fetch = mockSyncServer();
    expect((await syncNow()).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(getSyncState().status).toBe("idle");
  } finally {
    stop();
    clock.restore();
  }
});

test("signed-out automatic checks reuse authentication for five minutes", async () => {
  const clock = createSyncClock();
  globalThis.fetch = mock(async () => Response.json({ user: null })) as typeof fetch;
  const stop = startAutoSync();
  try {
    await clock.settle();
    await autoSyncNow();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(clock.nextDelay()).toBe(300_000);
    await clock.advance(300_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  } finally {
    stop();
    clock.restore();
  }
});

test("edits saved while hidden wait until the page becomes visible", async () => {
  const clock = createSyncClock();
  const { chapter } = seedRecords();
  setSyncAccount("account");
  const fetch = mockSyncServer();
  const stop = startAutoSync();
  try {
    await clock.advance(5_000);
    Object.assign(clock.document, { visibilityState: "hidden" });
    clock.document.dispatchEvent(new Event("visibilitychange"));
    storage.saveChapter({ ...chapter, honbun: "hidden edit" });
    await clock.advance(300_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(storage.pendingPushCount()).toBe(1);
    Object.assign(clock.document, { visibilityState: "visible" });
    clock.document.dispatchEvent(new Event("visibilitychange"));
    await clock.settle();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/api/sync/snapshot", "/api/auth/me", "/api/sync/push", "/api/sync/snapshot",
    ]);
    expect(storage.pendingPushCount()).toBe(0);
  } finally {
    stop();
    clock.restore();
  }
});

test("a newer edit made during an automatic upload is sent by a follow-up batch", async () => {
  const clock = createSyncClock();
  const { chapter } = seedRecords();
  setSyncAccount("account");
  const uploaded: string[] = [];
  let finishFirst!: () => void;
  const firstResponse = new Promise<void>((resolve) => { finishFirst = resolve; });
  globalThis.fetch = mock(async (_url, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      uploaded.push(body.chapters[0].honbun);
      if (uploaded.length === 1) await firstResponse;
      return Response.json({ results: { syosetu: [], chapters: [{ id: chapter.id, winner: "client" }] } });
    }
    return Response.json({ serverTime: Date.now(), syosetu: [], chapters: [] });
  }) as typeof fetch;
  const stop = startAutoSync();
  try {
    await clock.advance(5_000);
    storage.saveChapter({ ...chapter, honbun: "first" });
    await clock.advance(2_000);
    expect(uploaded).toEqual(["first"]);
    storage.saveChapter({ ...chapter, honbun: "during upload" });
    await clock.advance(10_000);
    expect(uploaded).toEqual(["first"]);
    finishFirst();
    await clock.settle();
    expect(storage.pendingPushCount()).toBe(1);
    await clock.advance(2_000);
    expect(uploaded).toEqual(["first", "during upload"]);
    expect(storage.pendingPushCount()).toBe(0);
  } finally {
    finishFirst();
    await clock.settle();
    stop();
    clock.restore();
  }
});

test("offline saves are kept and sent together when connectivity returns", async () => {
  const clock = createSyncClock();
  const { chapter } = seedRecords();
  setSyncAccount("account");
  const fetch = mockSyncServer();
  const stop = startAutoSync();
  try {
    await clock.advance(5_000);
    clock.navigator.onLine = false;
    storage.saveChapter({ ...chapter, honbun: "offline edit" });
    await clock.advance(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(storage.pendingPushCount()).toBe(1);
    clock.navigator.onLine = true;
    clock.window.dispatchEvent(new Event("online"));
    await clock.settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(storage.pendingPushCount()).toBe(0);
  } finally {
    stop();
    clock.restore();
  }
});

test.each([0, 401])("failed upload with status %s avoids a redundant download", async (status) => {
  const { chapter } = seedRecords();
  setSyncAccount("account");
  storage.saveChapter({ ...chapter, honbun: "pending" });
  globalThis.fetch = mock(async () => {
    if (status === 0) throw new Error("connection lost");
    return Response.json({ error: "expired" }, { status });
  }) as typeof fetch;
  expect((await syncNow()).ok).toBe(false);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(storage.pendingPushCount()).toBe(1);
});

test("account switching away and back still invalidates an old download", async () => {
  const { work, chapter } = seedRecords();
  setSyncAccount("account");
  globalThis.fetch = mock(async () => {
    setSyncAccount("other-account");
    setSyncAccount("account");
    return Response.json({
      serverTime: 200,
      syosetu: [{ ...work, createdAt: 1, updatedAt: 200 }],
      chapters: [{ ...chapter, createdAt: 1, honbun: "stale", updatedAt: 200 }],
    });
  }) as typeof fetch;
  expect((await downloadSync()).ok).toBe(false);
  expect(storage.getChapterById(chapter.id)?.honbun).toBe(chapter.honbun);
});

test("successful deletions are not sent again if a later deletion fails", async () => {
  const { work, chapter } = seedRecords();
  const other = storage.setSyosetu({ title: "other", pages: 0, plot: "" });
  storage.deleteSyosetu(other.title);
  storage.deleteChapter(work.title, 1);
  globalThis.fetch = mock(async (url) => String(url).includes("/chapter/")
    ? Response.json({ error: "retry" }, { status: 500 })
    : Response.json({ ok: true })) as typeof fetch;
  expect((await uploadSync()).ok).toBe(false);
  expect(storage.listDirtySyosetu()).toEqual([]);
  expect(storage.pendingPushCount()).toBe(1);
  globalThis.fetch = mock(async () => Response.json({ ok: true })) as typeof fetch;
  expect((await uploadSync()).ok).toBe(true);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe(`/api/sync/chapter/${chapter.id}`);
});

test("manual synchronization clears the old batch deadline before a later edit", async () => {
  const clock = createSyncClock();
  const { chapter } = seedRecords();
  setSyncAccount("account");
  const fetch = mockSyncServer();
  const stop = startAutoSync();
  try {
    await clock.advance(5_000);
    storage.saveChapter({ ...chapter, honbun: "first" });
    await syncNow();
    await clock.advance(20_000);
    storage.saveChapter({ ...chapter, honbun: "second" });
    expect(clock.nextDelay()).toBe(2_000);
    await clock.advance(1_999);
    expect(fetch).toHaveBeenCalledTimes(3);
    await clock.advance(1);
    expect(fetch).toHaveBeenCalledTimes(5);
  } finally {
    stop();
    clock.restore();
  }
});

test("stopping during an authentication request does not recreate a timer", async () => {
  const clock = createSyncClock();
  let finish!: (response: Response) => void;
  globalThis.fetch = mock(() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
  const stop = startAutoSync();
  try {
    stop();
    finish(Response.json({ user: null }));
    await clock.settle();
    expect(clock.pendingTimers()).toBe(0);
    await clock.advance(1_000_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    clock.restore();
  }
});
