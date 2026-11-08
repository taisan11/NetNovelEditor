import { afterEach, beforeEach, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../server/index";
import { AUTH_COOKIE, signSessionToken } from "../server/auth";
import { migrateCloudFeatures } from "../scripts/migrate-cloud";
import { setAccountPlan } from "../scripts/set-plan";
import { PLANS } from "../shared/plans";

let directory: string;
let client: Client;
let env: Parameters<typeof app.request>[2];
let cookie: string;
const values = { fontSize: 20, lineHeight: 1.8, theme: "dark", verticalWriting: true };
const work = (id: string) => ({ id, title: id, plot: "", pages: 0, updatedAt: 100, createdAt: 100, deleted: false });
const chapter = (id: string, syosetuId = "work") => ({ id, syosetuId, title: id, page: 1, honbun: "text", updatedAt: 100, createdAt: 100, deleted: false });

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "nne-cloud-"));
  const url = `file:${join(directory, "test.sqlite")}`;
  client = createClient({ url });
  await client.executeMultiple(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (id TEXT PRIMARY KEY, google_id TEXT NOT NULL UNIQUE, email TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE syosetu (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, pages INTEGER NOT NULL DEFAULT 0, plot TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE chapter (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      syosetu_id TEXT NOT NULL REFERENCES syosetu(id) ON DELETE CASCADE,
      title TEXT NOT NULL, page INTEGER NOT NULL, honbun TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO users VALUES ('user', 'google', 'writer@example.com', 1, 1);
    INSERT INTO users VALUES ('other', 'other-google', 'other@example.com', 1, 1);
  `);
  await migrateCloudFeatures(client);
  env = {
    TURSO_URL: url, TURSO_TOKEN: "", JWT_SECRET: "test-secret-at-least-32-bytes-long",
    GOOGLE_ID: "", GOOGLE_SECRET: "", GOOGLE_REDIRECT_URI: "",
    RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
  cookie = `${AUTH_COOKIE}=${await signSessionToken(env.JWT_SECRET, { sub: "user", email: "writer@example.com" })}`;
});

afterEach(() => {
  client.close();
  rmSync(directory, { recursive: true, force: true });
});

function request(path: string, body?: unknown, init: RequestInit = {}) {
  return app.request(`https://editor.example/api/sync${path}`, {
    method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body),
    ...init, headers: { Cookie: cookie, "Content-Type": "application/json", ...init.headers },
  }, env);
}

async function seedWorks(count: number) {
  for (let i = 0; i < count; i++) {
    await client.execute({
      sql: "INSERT INTO syosetu (id, user_id, title, created_at, updated_at) VALUES (?, 'user', ?, 1, 1)",
      args: [`seed-${i}`, `seed-${i}`],
    });
  }
}

test("cloud migration is additive, repeatable and defaults existing accounts to free", async () => {
  await seedWorks(1);
  await migrateCloudFeatures(client);
  const res = await request("/snapshot");
  const data = await res.json();
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(data.plan).toMatchObject({ id: "free", usage: { works: 1 } });
  expect(data.settings).toBeNull();
  expect(data.syosetu).toHaveLength(1);
  expect((await client.execute("SELECT * FROM users")).rows).toHaveLength(2);
});

test.each(["/syosetu", "/push"])("%s enforces work quotas and rolls back the whole batch", async (path) => {
  await seedWorks(10);
  const body = path === "/push"
    ? { syosetu: [{ ...work("seed-0"), plot: "must roll back" }, work("extra")], chapters: [], plan: "pro" }
    : work("extra");
  const response = await request(path, body);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "PLAN_LIMIT_EXCEEDED" });
  const data = await (await request("/snapshot")).json();
  expect(data.syosetu).toHaveLength(10);
  expect(data.syosetu.find((s: { id: string }) => s.id === "seed-0").plot).toBe("");
});

test("Pro is administrator-controlled and a downgrade never deletes stored works", async () => {
  await seedWorks(10);
  await setAccountPlan(client, "user", "pro");
  expect((await request("/syosetu", work("extra"))).status).toBe(200);
  await setAccountPlan(client, "user", "free");
  const data = await (await request("/snapshot")).json();
  expect(data.plan).toMatchObject({ id: "free", usage: { works: 11 } });
  expect(data.syosetu).toHaveLength(11);
  expect((await request("/syosetu", { ...work("extra"), title: "edit", updatedAt: 101 })).status).toBe(200);
  expect((await request("/syosetu", work("blocked"))).status).toBe(403);
  await expect(setAccountPlan(client, "missing", "pro")).rejects.toThrow("見つかりません");
});

test("simultaneous uploads cannot exceed the work limit", async () => {
  await seedWorks(9);
  const responses = await Promise.all([
    request("/syosetu", work("concurrent-a")),
    request("/syosetu", work("concurrent-b")),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 403]);
  expect((await (await request("/snapshot")).json()).plan.usage.works).toBe(10);
});

test("deleting cloud works frees quota and restoring them is checked", async () => {
  await seedWorks(10);
  expect((await request("/syosetu/seed-0", undefined, { method: "DELETE" })).status).toBe(200);
  expect((await request("/syosetu", work("replacement"))).status).toBe(200);
  expect((await request("/syosetu", { ...work("seed-0"), updatedAt: Date.now() + 1_000 })).status).toBe(403);
  const data = await (await request("/snapshot")).json();
  expect(data.plan.usage.works).toBe(10);
});

test.each(["/chapter", "/push"])("%s checks aggregate UTF-8 bytes, including chapters", async (path) => {
  await request("/syosetu", work("work"));
  await client.execute({
    sql: "INSERT INTO chapter (id, user_id, syosetu_id, title, page, honbun, created_at, updated_at) VALUES ('large', 'user', 'work', '', 1, ?, 1, 1)",
    args: ["あ".repeat(3_400_000)],
  });
  const newChapter = { ...chapter("extra"), honbun: "あ".repeat(100_000) };
  const response = await request(path, path === "/push" ? { syosetu: [], chapters: [newChapter] } : newChapter);
  expect(response.status).toBe(403);
  const data = await (await request("/snapshot")).json();
  expect(data.plan.usage.storageBytes).toBe(10_200_004);
  expect(data.chapters).toHaveLength(1);
});

test("over-capacity accounts may shrink data and sync preferences", async () => {
  await request("/syosetu", work("work"));
  await client.execute({
    sql: "INSERT INTO chapter (id, user_id, syosetu_id, title, page, honbun, created_at, updated_at) VALUES ('large', 'user', 'work', '', 1, ?, 1, 1)",
    args: ["x".repeat(PLANS.free.maxStorageBytes + 1_000)],
  });
  expect((await request("/push", { syosetu: [], chapters: [], settings: { values, updatedAt: 100 } })).status).toBe(200);
  expect((await request("/chapter", { ...chapter("large"), honbun: "smaller" })).status).toBe(200);
  const data = await (await request("/snapshot")).json();
  expect(data.settings.values).toEqual(values);
  expect(data.plan.usage.storageBytes).toBeLessThan(PLANS.free.maxStorageBytes);
});

test("settings use latest-write-wins and cannot be read or changed by another account", async () => {
  const push = (settings: unknown) => request("/push", { syosetu: [], chapters: [], settings });
  expect((await push({ values, updatedAt: 200 })).status).toBe(200);
  const old = await push({ values: { ...values, theme: "light" }, updatedAt: 100 });
  expect((await old.json()).settings).toEqual({ values, updatedAt: 200 });
  await push({ values: { ...values, theme: "sepia" }, updatedAt: 200 });
  expect((await (await request("/snapshot")).json()).settings.values.theme).toBe("dark");
  cookie = `${AUTH_COOKIE}=${await signSessionToken(env!.JWT_SECRET, { sub: "other", email: "other@example.com" })}`;
  expect((await (await request("/snapshot")).json()).settings).toBeNull();
});

test.each([
  { values: { ...values, fontSize: 999 }, updatedAt: 100 },
  { values: { ...values, theme: "unknown" }, updatedAt: 100 },
  { values, updatedAt: -1 },
  { values, updatedAt: 0.5 },
  null,
])("invalid settings are rejected: %j", async (settings) => {
  expect((await request("/push", { syosetu: [], chapters: [], settings })).status).toBe(400);
});

test("settings and plan data require authentication and writes reject foreign origins", async () => {
  expect((await request("/push", { syosetu: [], chapters: [] }, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
  cookie = "";
  expect((await request("/snapshot")).status).toBe(401);
  expect((await request("/push", { syosetu: [], chapters: [], settings: { values, updatedAt: 100 } })).status).toBe(401);
});
