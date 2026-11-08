import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { resetStorage, seedRecords } from "./helpers";
import { acceptSettings, getPendingSettings, getSettings, getSettingsRecord, setSettings, SETTINGS_KEY, subscribeSettings } from "../src/settings";
import { downloadSync, getSyncState, setSyncAccount, syncNow, uploadSync } from "../src/sync";
import * as storage from "../src/storage";

const originalFetch = globalThis.fetch;
const values = { fontSize: 20, lineHeight: 1.8, theme: "dark" as const, verticalWriting: true };
beforeEach(() => { resetStorage(); setSyncAccount("settings-account"); });
afterEach(() => { globalThis.fetch = originalFetch; setSyncAccount(null); });

test("default settings do not overwrite existing cloud settings on a new device", async () => {
  expect(getPendingSettings("settings-account")).toBeNull();
  globalThis.fetch = mock(async () => Response.json({
    syosetu: [], chapters: [], settings: { values, updatedAt: 100 }, serverTime: 200,
  })) as typeof fetch;
  expect((await downloadSync()).ok).toBe(true);
  expect(getSettings()).toEqual(values);
  expect(getPendingSettings("settings-account")).toBeNull();
});

test("old flat settings migrate without assigning a new revision on every read", () => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(values));
  expect(getPendingSettings("settings-account")).toEqual({ values, updatedAt: 1 });
  expect(getSettingsRecord()?.updatedAt).toBe(1);
});

test("saved font sizes below 16px are clamped without changing their revision", () => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...values, fontSize: 12, updatedAt: 100 }));
  expect(getSettings().fontSize).toBe(16);
  expect(getSettingsRecord()?.updatedAt).toBe(100);
});

test("local font size changes cannot save values below 16px", () => {
  setSettings({ ...values, fontSize: 12 });
  expect(getSettings().fontSize).toBe(16);
  expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).fontSize).toBe(16);
});

test("cloud font sizes below 16px are clamped before notifying the settings screen", () => {
  const listener = mock(() => {});
  const unsubscribe = subscribeSettings(listener);
  try {
    expect(acceptSettings({ values: { ...values, fontSize: 12 }, updatedAt: 100 }, "settings-account")).toBe(true);
    expect(getSettings().fontSize).toBe(16);
    expect(listener).toHaveBeenCalledWith({ ...values, fontSize: 16 });
    expect(getPendingSettings("settings-account")).toBeNull();
  } finally {
    unsubscribe();
  }
});

test("local setting changes have increasing revisions and account-scoped acknowledgements", () => {
  setSettings(values);
  const sent = getSettingsRecord()!;
  expect(getSyncState().pendingPush).toBe(1);
  expect(acceptSettings(sent, "settings-account", sent)).toBe(true);
  expect(getPendingSettings("settings-account")).toBeNull();
  expect(getPendingSettings("other-account")).toEqual(sent);
  setSettings(values);
  expect(getPendingSettings("settings-account")).toBeNull();
  setSettings({ ...values, fontSize: 21 });
  expect(getSettingsRecord()!.updatedAt).toBeGreaterThan(sent.updatedAt);
});

test("settings upload acknowledges only the sent revision", async () => {
  setSettings(values);
  globalThis.fetch = mock(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.settings.values).toEqual(values);
    return Response.json({ results: { syosetu: [], chapters: [] }, settings: body.settings });
  }) as typeof fetch;
  expect((await uploadSync()).ok).toBe(true);
  expect(getPendingSettings("settings-account")).toBeNull();
  expect(getSyncState().pendingPush).toBe(0);
});

test("a change made while settings are uploading stays pending", async () => {
  setSettings(values);
  globalThis.fetch = mock(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    setSettings({ ...values, fontSize: 24 });
    return Response.json({ results: { syosetu: [], chapters: [] }, settings: body.settings });
  }) as typeof fetch;
  await uploadSync();
  expect(getSettings().fontSize).toBe(24);
  expect(getPendingSettings("settings-account")?.values.fontSize).toBe(24);
});

test("settings and novel changes share one upload request", async () => {
  const { work, chapter } = seedRecords();
  setSettings(values);
  storage.saveSyosetu({ ...work, plot: "edited" });
  storage.saveChapter({ ...chapter, honbun: "edited" });
  globalThis.fetch = mock(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.settings.values).toEqual(values);
    expect(body.syosetu).toHaveLength(1);
    expect(body.chapters).toHaveLength(1);
    return Response.json({
      results: {
        syosetu: [{ id: work.id, winner: "client" }],
        chapters: [{ id: chapter.id, winner: "client" }],
      },
      settings: body.settings,
    });
  }) as typeof fetch;
  expect((await uploadSync()).ok).toBe(true);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  expect(getSyncState().pendingPush).toBe(0);
});

test("a change made while downloading is not replaced by a remote setting", async () => {
  globalThis.fetch = mock(async () => {
    setSettings({ ...values, fontSize: 24 });
    return Response.json({ syosetu: [], chapters: [], settings: { values, updatedAt: Date.now() + 100_000 }, serverTime: 200 });
  }) as typeof fetch;
  await downloadSync();
  expect(getSettings().fontSize).toBe(24);
});

test("settings notifications update an open settings screen without creating unsent changes", () => {
  const listener = mock(() => {});
  const unsubscribe = subscribeSettings(listener);
  const record = { values, updatedAt: 100 };
  expect(acceptSettings(record, "settings-account")).toBe(true);
  expect(listener).toHaveBeenCalledWith(values);
  expect(getPendingSettings("settings-account")).toBeNull();
  unsubscribe();
  acceptSettings({ values, updatedAt: 200 }, "settings-account");
  expect(listener).toHaveBeenCalledTimes(1);
});

test("older snapshots cannot roll back an already acknowledged settings revision", () => {
  acceptSettings({ values, updatedAt: 200 }, "settings-account");
  expect(acceptSettings({ values: { ...values, fontSize: 12 }, updatedAt: 100 }, "settings-account")).toBe(false);
  expect(getSettings().fontSize).toBe(20);
});

test("account changes during settings upload ignore the old account response", async () => {
  setSettings(values);
  globalThis.fetch = mock(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    setSyncAccount("other-account");
    return Response.json({ results: { syosetu: [], chapters: [] }, settings: body.settings });
  }) as typeof fetch;
  expect((await uploadSync()).ok).toBe(false);
  expect(getPendingSettings("settings-account")).not.toBeNull();
  expect(getPendingSettings("other-account")).not.toBeNull();
});

test("quota errors preserve local novels but still sync settings and download cloud records", async () => {
  setSettings(values);
  storage.saveSyosetu({ id: "local", title: "local", plot: "unsent", pages: 0 });
  const calls: string[] = [];
  globalThis.fetch = mock(async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("/snapshot")) return Response.json({
      syosetu: [], chapters: [], settings: null, serverTime: 200,
      plan: { id: "free", usage: { works: 10, storageBytes: 100 } },
    });
    const body = JSON.parse(String(init?.body));
    return body.syosetu.length > 0
      ? Response.json({ error: "plan limit" }, { status: 403 })
      : Response.json({ results: { syosetu: [], chapters: [] }, settings: body.settings });
  }) as typeof fetch;
  expect((await syncNow()).ok).toBe(false);
  expect(calls).toEqual(["/api/sync/push", "/api/sync/push", "/api/sync/snapshot"]);
  expect(getPendingSettings("settings-account")).toBeNull();
  expect(storage.getSyosetuById("local")?.dirty).toBe(true);
  expect(getSyncState().plan?.usage.works).toBe(10);
});

test("storage failures never acknowledge unsaved remote settings", () => {
  const memory = localStorage as ReturnType<typeof resetStorage>;
  memory.failWrite = (key) => key === SETTINGS_KEY;
  expect(() => acceptSettings({ values, updatedAt: 100 }, "settings-account")).toThrow();
  memory.failWrite = null;
  expect(getSettingsRecord()).toBeNull();
});
