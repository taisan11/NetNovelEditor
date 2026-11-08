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

const originalFetch = globalThis.fetch;
beforeEach(() => {
  resetStorage();
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
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  const clearInterval = mock(() => {});
  let poll!: () => void;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(windowTarget, {
      setInterval: mock((callback: () => void, delay: number) => {
        expect(delay).toBe(60_000);
        poll = callback;
        return 1;
      }),
      clearInterval,
    }),
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: Object.assign(documentTarget, { visibilityState: "visible" }),
  });
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
    for (const trigger of [
      () => windowTarget.dispatchEvent(new Event("focus")),
      () => windowTarget.dispatchEvent(new Event("online")),
      () => documentTarget.dispatchEvent(new Event("visibilitychange")),
      poll,
    ]) {
      const before = (globalThis.fetch as ReturnType<typeof mock>).mock.calls.length;
      trigger();
      await autoSyncNow();
      expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(before + 2);
    }
    Object.assign(documentTarget, { visibilityState: "hidden" });
    const before = (globalThis.fetch as ReturnType<typeof mock>).mock.calls.length;
    poll();
    await autoSyncNow();
    expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(before);
    stop();
    Object.assign(documentTarget, { visibilityState: "visible" });
    windowTarget.dispatchEvent(new Event("focus"));
    windowTarget.dispatchEvent(new Event("online"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect((globalThis.fetch as ReturnType<typeof mock>).mock.calls.length).toBe(before);
    expect(clearInterval).toHaveBeenCalledWith(1);
  } finally {
    stop?.();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
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

test("failed chapter deletion retains all tombstones for retry", async () => {
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
  const failed = await uploadSync();
  expect(failed).toMatchObject({
    ok: false,
    deleteRequestsSent: 1,
    pushedSyosetu: 1,
    pushedChapters: 0,
    error: "retry later",
  });
  expect(storage.pendingPushCount()).toBe(2);
  expect(calls).toEqual([`/api/sync/syosetu/${work.id}`, `/api/sync/chapter/${chapter.id}`]);

  globalThis.fetch = mock(async () => Response.json({ ok: true })) as typeof fetch;
  expect(await uploadSync()).toMatchObject({
    ok: true,
    uploadRequestSent: false,
    deleteRequestsSent: 2,
    pushedSyosetu: 1,
    pushedChapters: 1,
  });
  expect(storage.pendingPushCount()).toBe(0);
  expect(storage.listAllSyosetuIncludingDirty()).toEqual([]);
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
