import { googleAuth } from "@hono/oauth-providers/google";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { users } from "./schema";
import { makeDb } from "./db";
import { signSessionToken } from "./auth";
import type { SessionContext } from "./middleware";

type AuthEnv = {
  Bindings: {
    TURSO_URL: string;
    TURSO_TOKEN: string;
    JWT_SECRET: string;
    GOOGLE_ID: string;
    GOOGLE_SECRET: string;
    GOOGLE_REDIRECT_URI: string;
  };
  Variables: SessionContext;
};

const app = new Hono<AuthEnv>();
const CALLBACK_PATH = "/api/auth/google/callback";
// @hono/oauth-providers uses this cookie name internally.
const STATE_COOKIE = "state";

function authError(c: Context<AuthEnv>, reason: string) {
  deleteCookie(c, STATE_COOKIE, { path: "/" });
  return c.redirect(`/?auth_error=${reason}#/settings`);
}

function getOptions(c: Context<AuthEnv>) {
  const { GOOGLE_ID, GOOGLE_SECRET, GOOGLE_REDIRECT_URI, JWT_SECRET } = c.env;
  if (!GOOGLE_ID || !GOOGLE_SECRET || !GOOGLE_REDIRECT_URI || !JWT_SECRET) return null;
  try {
    const redirect = new URL(GOOGLE_REDIRECT_URI);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
    if (redirect.protocol !== "https:" && !(local && redirect.protocol === "http:")) return null;
    if (
      redirect.pathname !== CALLBACK_PATH ||
      redirect.search ||
      redirect.hash ||
      redirect.username ||
      redirect.password
    )
      return null;
    // Keep the state cookie and the callback on the same origin.
    if (redirect.origin !== new URL(c.req.url).origin) return null;
    return {
      client_id: GOOGLE_ID,
      client_secret: GOOGLE_SECRET,
      redirect_uri: redirect.href,
      scope: ["openid", "email", "profile"],
      prompt: "select_account" as const,
    };
  } catch {
    return null;
  }
}

app.get("/google", async (c) => {
  const options = getOptions(c);
  if (!options) return authError(c, "configuration");
  // Never accept an authorization response on the initiation endpoint.
  if (c.req.query("code") || c.req.query("error") || c.req.query("state")) {
    return authError(c, "invalid_state");
  }
  const state = crypto.randomUUID();
  const response = await googleAuth({ ...options, state })(c, async () => {});
  if (!response) return authError(c, "failed");
  c.res = response;
  // The provider always sets Secure; allow plain HTTP only on local development.
  c.res.headers.delete("Set-Cookie");
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  return c.res;
});

app.get("/google/callback", async (c) => {
  const options = getOptions(c);
  if (!options) return authError(c, "configuration");
  const state = getCookie(c, STATE_COOKIE);
  if (!state || state !== c.req.query("state")) return authError(c, "invalid_state");
  deleteCookie(c, STATE_COOKIE, { path: "/" });
  if (c.req.query("error")) {
    return authError(c, c.req.query("error") === "access_denied" ? "cancelled" : "failed");
  }
  if (!c.req.query("code")) return authError(c, "failed");

  try {
    // The provider also validates state before exchanging the authorization code.
    await googleAuth(options)(c, async () => {});
    const profile = c.get("user-google");
    if (!profile?.id || !profile.email || profile.verified_email !== true) {
      return authError(c, "unverified_email");
    }
    const db = makeDb(c.env.TURSO_URL, c.env.TURSO_TOKEN);
    // Identity is the stable Google ID, never the (changeable) email address.
    // Upsert makes simultaneous first logins safe, without creating duplicates.
    const [user] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        googleId: profile.id,
        email: profile.email,
      })
      .onConflictDoUpdate({
        target: users.googleId,
        set: { email: profile.email, updatedAt: new Date() },
      })
      .returning({ id: users.id, email: users.email });

    const token = await signSessionToken(c.env.JWT_SECRET, { sub: user.id, email: user.email });
    c.var.setSessionCookie(token);
    return c.redirect("/?auth_success=1#/settings");
  } catch {
    // Do not expose Google's tokens, authorization codes or database errors.
    return authError(c, "failed");
  }
});

export default app;
