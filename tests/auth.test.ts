import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sign } from "hono/jwt";
import app from "../server/index";
import { AUTH_COOKIE, verifySessionToken } from "../server/auth";
import { migrateGoogleAuth } from "../scripts/migrate-google-auth";

const originalFetch = globalThis.fetch;
const origin = "https://editor.example";
let directory: string;
let client: Client;
let env: Parameters<typeof app.request>[2];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "nne-auth-"));
  const url = `file:${join(directory, "test.sqlite")}`;
  client = createClient({ url });
  await client.executeMultiple(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX users_email_idx ON users (email);
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
  `);
  env = {
    TURSO_URL: url,
    TURSO_TOKEN: "",
    JWT_SECRET: "test-only-session-secret-at-least-32-bytes",
    GOOGLE_ID: "test.apps.googleusercontent.com",
    GOOGLE_SECRET: "test-google-secret",
    GOOGLE_REDIRECT_URI: `${origin}/api/auth/google/callback`,
    RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  client.close();
  // Only remove the isolated directory created by this test.
  rmSync(directory, { recursive: true, force: true });
});

function request(path: string, init?: RequestInit) {
  return app.request(`${origin}${path}`, init, env);
}

async function startLogin() {
  const response = await request("/api/auth/google");
  const redirect = new URL(response.headers.get("Location")!);
  const state = redirect.searchParams.get("state")!;
  return { response, redirect, state, cookie: `state=${state}` };
}

function mockGoogle(profile: Record<string, unknown> = {}) {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://oauth2.googleapis.com/token") {
      const body = JSON.parse(String(init?.body));
      expect(body.redirect_uri).toBe(env!.GOOGLE_REDIRECT_URI);
      expect(body.code).toBe("google-code");
      return Response.json({
        access_token: "private-google-token",
        expires_in: 3600,
        scope: "openid email profile",
      });
    }
    if (url === "https://www.googleapis.com/oauth2/v2/userinfo") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-google-token");
      return Response.json({
        id: "google-user-123",
        email: "writer@example.com",
        verified_email: true,
        ...profile,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  return calls;
}

async function completeLogin() {
  const { state, cookie } = await startLogin();
  return request(`/api/auth/google/callback?code=google-code&state=${state}`, {
    headers: { Cookie: cookie },
  });
}

function sessionCookie(response: Response) {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${AUTH_COOKIE}=`))!;
}

test("login redirects to Google with minimal scopes and a short-lived secure state cookie", async () => {
  const { response, redirect, state } = await startLogin();
  expect(response.status).toBe(302);
  expect(redirect.origin).toBe("https://accounts.google.com");
  expect(redirect.searchParams.get("client_id")).toBe(env!.GOOGLE_ID);
  expect(redirect.searchParams.get("redirect_uri")).toBe(env!.GOOGLE_REDIRECT_URI);
  expect(redirect.searchParams.get("scope")).toBe("openid email profile");
  expect(redirect.searchParams.get("prompt")).toBe("select_account");
  expect(state.length).toBeGreaterThan(30);
  const cookie = response.headers.get("Set-Cookie")!;
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=600"])
    expect(cookie).toContain(attribute);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect((await startLogin()).state).not.toBe(state);
});

test("localhost login supports HTTP state cookies", async () => {
  const local = "http://localhost:5173";
  const response = await app.request(
    `${local}/api/auth/google`,
    {},
    {
      ...env!,
      GOOGLE_REDIRECT_URI: `${local}/api/auth/google/callback`,
    },
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
  expect(response.headers.get("Set-Cookie")).not.toContain("Secure");
});

test("missing credentials, unsafe redirects and origin mismatches fail without contacting Google", async () => {
  const fetchMock = mock(async () => {
    throw new Error("must not fetch");
  });
  globalThis.fetch = fetchMock as typeof fetch;
  for (const overrides of [
    { GOOGLE_SECRET: "" },
    { JWT_SECRET: "" },
    { GOOGLE_REDIRECT_URI: "https://other.example/api/auth/google/callback" },
    { GOOGLE_REDIRECT_URI: "http://editor.example/api/auth/google/callback" },
    { GOOGLE_REDIRECT_URI: `${origin}/wrong-path` },
  ]) {
    const response = await app.request(`${origin}/api/auth/google`, {}, { ...env!, ...overrides });
    expect(response.headers.get("Location")).toBe("/?auth_error=configuration#/settings");
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test("missing or mismatched state never exchanges the code", async () => {
  const fetchMock = mock(async () => {
    throw new Error("must not fetch");
  });
  globalThis.fetch = fetchMock as typeof fetch;
  for (const headers of [{}, { Cookie: "state=correct-state" }]) {
    const response = await request("/api/auth/google/callback?code=google-code&state=wrong-state", {
      headers,
    });
    expect(response.headers.get("Location")).toBe("/?auth_error=invalid_state#/settings");
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(sessionCookie(response)).toBeUndefined();
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

test("cancellation and incomplete callbacks return to settings without a session", async () => {
  const { state, cookie } = await startLogin();
  const cancelled = await request(`/api/auth/google/callback?error=access_denied&state=${state}`, {
    headers: { Cookie: cookie },
  });
  expect(cancelled.headers.get("Location")).toBe("/?auth_error=cancelled#/settings");
  expect(sessionCookie(cancelled)).toBeUndefined();
  const incomplete = await request(`/api/auth/google/callback?state=${state}`, {
    headers: { Cookie: cookie },
  });
  expect(incomplete.headers.get("Location")).toBe("/?auth_error=failed#/settings");
  const wrongEndpoint = await request(`/api/auth/google?code=google-code&state=${state}`, {
    headers: { Cookie: cookie },
  });
  expect(wrongEndpoint.headers.get("Location")).toBe("/?auth_error=invalid_state#/settings");
});

test("first Google login creates an account, sets a session and authorizes sync", async () => {
  await migrateGoogleAuth(client);
  const calls = mockGoogle();
  const response = await completeLogin();
  expect(response.headers.get("Location")).toBe("/?auth_success=1#/settings");
  expect(calls).toHaveLength(2);
  const cookie = sessionCookie(response);
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=604800"])
    expect(cookie).toContain(attribute);
  expect(response.headers.get("Set-Cookie")).not.toContain("private-google-token");
  const payload = await verifySessionToken(
    cookie.split(";")[0].slice(AUTH_COOKIE.length + 1),
    env!.JWT_SECRET,
  );
  const rows = await client.execute("SELECT * FROM users");
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0].google_id).toBe("google-user-123");
  expect(rows.rows[0].id).toBe(payload.sub);
  const headers = { Cookie: cookie.split(";")[0] };
  const me = await request("/api/auth/me", { headers });
  expect(await me.json()).toEqual({ user: { id: payload.sub, email: "writer@example.com" } });
  expect(me.headers.get("Cache-Control")).toBe("no-store");
  const snapshot = await request("/api/sync/snapshot", { headers });
  expect(snapshot.status).toBe(200);
  expect((await snapshot.json()).syosetu).toEqual([]);
});

test("repeat login retains the user ID and updates a changed Google email", async () => {
  await migrateGoogleAuth(client);
  mockGoogle();
  await completeLogin();
  const first = (await client.execute("SELECT * FROM users")).rows[0];
  mockGoogle({ email: "renamed@example.com" });
  await completeLogin();
  const rows = (await client.execute("SELECT * FROM users")).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(first.id);
  expect(rows[0].created_at).toBe(first.created_at);
  expect(rows[0].email).toBe("renamed@example.com");
});

test("different Google IDs are never merged by email address", async () => {
  await migrateGoogleAuth(client);
  mockGoogle();
  await completeLogin();
  mockGoogle({ id: "another-google-user" });
  await completeLogin();
  const rows = (await client.execute("SELECT * FROM users")).rows;
  expect(rows).toHaveLength(2);
  expect(rows[0].id).not.toBe(rows[1].id);
});

test("simultaneous first logins create only one user", async () => {
  await migrateGoogleAuth(client);
  mockGoogle();
  const responses = await Promise.all([completeLogin(), completeLogin()]);
  for (const response of responses)
    expect(response.headers.get("Location")).toBe("/?auth_success=1#/settings");
  expect((await client.execute("SELECT * FROM users")).rows).toHaveLength(1);
});

test("unverified or incomplete Google profiles cannot create accounts", async () => {
  await migrateGoogleAuth(client);
  for (const profile of [
    { verified_email: false },
    { verified_email: "true" },
    { email: "" },
    { id: "" },
  ]) {
    mockGoogle(profile);
    const response = await completeLogin();
    expect(response.headers.get("Location")).toBe("/?auth_error=unverified_email#/settings");
    expect(sessionCookie(response)).toBeUndefined();
  }
  expect((await client.execute("SELECT * FROM users")).rows).toHaveLength(0);
});

test("provider and database failures do not expose details or establish a session", async () => {
  globalThis.fetch = mock(async () =>
    Response.json({ error: "invalid_grant", error_description: "private-error-detail" }),
  ) as typeof fetch;
  const providerError = await completeLogin();
  expect(providerError.headers.get("Location")).toBe("/?auth_error=failed#/settings");
  expect(sessionCookie(providerError)).toBeUndefined();
  mockGoogle();
  // Deliberately use the unmigrated legacy schema.
  const databaseError = await completeLogin();
  expect(databaseError.headers.get("Location")).toBe("/?auth_error=failed#/settings");
  expect(sessionCookie(databaseError)).toBeUndefined();
});

test("signout clears sessions, rejects foreign origins, and legacy signin is removed", async () => {
  const response = await request("/api/auth/signout", {
    method: "POST",
    headers: { Origin: origin },
  });
  expect(response.status).toBe(200);
  expect(sessionCookie(response)).toContain("Max-Age=0");
  expect(
    (
      await request("/api/auth/signout", {
        method: "POST",
        headers: { Origin: "https://evil.example" },
      })
    ).status,
  ).toBe(403);
  expect((await request("/api/auth/signin", { method: "POST" })).status).toBe(404);
  expect(await (await request("/api/auth/me")).json()).toEqual({ user: null });
  expect((await request("/api/sync/snapshot")).status).toBe(401);
});

test("old password-based sessions are no longer accepted", async () => {
  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
    {
      sub: "legacy-user",
      email: "old@example.com",
      iss: "netnoveleditor",
      iat: now,
      exp: now + 3600,
    },
    env!.JWT_SECRET,
    "HS256",
  );
  const response = await request("/api/auth/me", {
    headers: { Cookie: `${AUTH_COOKIE}=${token}` },
  });
  expect(await response.json()).toEqual({ user: null });
});

test("legacy migration deletes old cloud data, retains foreign keys and is safe to repeat", async () => {
  await client.executeMultiple(`
    INSERT INTO users VALUES ('legacy', 'legacy@example.com', 'old-hash', 1, 1);
    INSERT INTO syosetu (id, user_id, title, created_at, updated_at) VALUES ('work', 'legacy', 'old work', 1, 1);
    INSERT INTO chapter (id, user_id, syosetu_id, title, page, created_at, updated_at) VALUES ('chapter', 'legacy', 'work', 'old chapter', 1, 1, 1);
  `);
  expect(await migrateGoogleAuth(client)).toBe(true);
  for (const table of ["users", "syosetu", "chapter"])
    expect((await client.execute(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
  expect((await client.execute("PRAGMA foreign_key_check")).rows).toHaveLength(0);
  mockGoogle();
  await completeLogin();
  expect(await migrateGoogleAuth(client)).toBe(false);
  expect((await client.execute("SELECT * FROM users")).rows).toHaveLength(1);
  const columns = (await client.execute("PRAGMA table_info(users)")).rows.map((row) => row.name);
  expect(columns).toContain("google_id");
  expect(columns).not.toContain("password_hash");
});

test("a failed migration rolls back deleted data", async () => {
  await client.executeMultiple(`
    INSERT INTO users VALUES ('legacy', 'legacy@example.com', 'old-hash', 1, 1);
    INSERT INTO syosetu (id, user_id, title, created_at, updated_at) VALUES ('work', 'legacy', 'old work', 1, 1);
    INSERT INTO chapter (id, user_id, syosetu_id, title, page, created_at, updated_at) VALUES ('chapter', 'legacy', 'work', 'old chapter', 1, 1, 1);
    CREATE TRIGGER refuse_delete BEFORE DELETE ON syosetu BEGIN SELECT RAISE(ABORT, 'test failure'); END;
  `);
  await expect(migrateGoogleAuth(client)).rejects.toThrow();
  for (const table of ["users", "syosetu", "chapter"])
    expect((await client.execute(`SELECT * FROM ${table}`)).rows).toHaveLength(1);
  expect((await client.execute("PRAGMA table_info(users)")).rows.map((row) => row.name)).toContain(
    "password_hash",
  );
});
