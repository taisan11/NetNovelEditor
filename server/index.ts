import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { session, rateLimit, type SessionContext, type RateLimitBinding } from "./middleware";
import googleAuthApp from "./google-auth";
import syncApp from "./sync";

interface Bindings {
  TURSO_URL: string;
  TURSO_TOKEN: string;
  JWT_SECRET: string;
  GOOGLE_ID: string;
  GOOGLE_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  RATE_LIMITER: RateLimitBinding;
}

const app = new Hono<{ Bindings: Bindings; Variables: SessionContext }>();

app.use("/api/*", secureHeaders());
app.use("/api/*", rateLimit);
app.use("/api/*", session);
app.use("/api/auth/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/auth", googleAuthApp);

app.post("/api/auth/signout", (c) => {
  // Reject cross-origin form submissions as well as cross-origin fetches.
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    return c.json({ error: "不正なリクエストです" }, 403);
  }
  c.var.clearSessionCookie();
  return c.json({ ok: true });
});

app.get("/api/auth/me", (c) => c.json({ user: c.get("user") }));
app.route("/api/sync", syncApp);

export default app;
