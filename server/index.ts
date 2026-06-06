import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { eq } from "drizzle-orm"
import { users } from "./schema"
import { hashPassword, verifyPassword, signSessionToken } from "./auth"
import {
  session,
  requireAuth,
  rateLimit,
  type SessionContext,
  type RateLimitBinding,
} from "./middleware"
import { makeDb } from "./db"
import { SIGNIN_BODY_MAX_BYTES } from "./limits"
import syncApp from "./sync"
import {secureHeaders} from "hono/secure-headers"

interface Bindings {
  TURSO_URL: string
  TURSO_TOKEN: string
  JWT_SECRET: string
  RATE_LIMITER: RateLimitBinding
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function jsonError(message: string, status: 400 | 401 | 409 | 500 = 400) {
  return { error: message, status }
}

function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email)
}

function isValidPassword(pw: string): boolean {
  return pw.length >= 8 && pw.length <= 128
}

function newId(): string {
  return crypto.randomUUID()
}

const app = new Hono<{ Bindings: Bindings; Variables: SessionContext }>()

app.use("/api/*", rateLimit)
app.use("/api/*", session)
app.use("/api/*",secureHeaders())
// CORSは必要に応じて有効化する
// というかデフォルトでブロックされるからなブラウザさんは
// app.use("/api/*", cors())

// app.get("/", (c) => c.text("Hello, World!"))

app.get("/api/health", (c) => c.json({ ok: true }))

// いったん封印
//TODO: OAuth2ログインを確認する
// app.post("/api/auth/signup", async (c) => {
//   const body = (await c.req.json().catch(() => null)) as
//     | { email?: unknown; password?: unknown }
//     | null
//   if (!body) return c.json(jsonError("リクエストボディが不正です"), 400)
//   const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
//   const password = typeof body.password === "string" ? body.password : ""
//   if (!isValidEmail(email)) return c.json(jsonError("メールアドレスの形式が不正です"), 400)
//   if (!isValidPassword(password))
//     return c.json(jsonError("パスワードは8〜128文字で指定してください"), 400)

//   const db = makeDb(c.env.TURSO_URL, c.env.TURSO_TOKEN)
//   const existing = await db.select().from(users).where(eq(users.email, email)).limit(1)
//   if (existing.length > 0) return c.json(jsonError("このメールアドレスは既に登録されています"), 409)

//   const passwordHash = await hashPassword(password)
//   const id = newId()
//   await db.insert(users).values({ id, email, passwordHash })

//   const secret = c.env.JWT_SECRET
//   if (!secret) return c.json(jsonError("サーバー設定エラー"), 500)
//   const token = await signSessionToken(secret, { sub: id, email })
//   c.var.setSessionCookie(token)
//   return c.json({ user: { id, email } }, 201)
// })

app.post(
  "/api/auth/signin",
  bodyLimit({
    maxSize: SIGNIN_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "request body too large" }, 413),
  }),
  async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { id?: unknown; password?: unknown }
      | null
    if (!body) return c.json(jsonError("リクエストボディが不正です"), 400)
    const id = typeof body.id === "string" ? body.id.trim().toLowerCase() : ""
    const password = typeof body.password === "string" ? body.password : ""
    if (!id || !password) return c.json(jsonError("認証情報が不正です"), 401)

    const db = makeDb(c.env.TURSO_URL, c.env.TURSO_TOKEN)
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1)
    const user = rows[0]
    if (!user) return c.json(jsonError("認証情報が不正です"), 401)
    const ok = await verifyPassword(password, user.passwordHash)
    if (!ok) return c.json(jsonError("認証情報が不正です"), 401)

    const secret = c.env.JWT_SECRET
    if (!secret) return c.json(jsonError("サーバー設定エラー"), 500)
    const token = await signSessionToken(secret, { sub: user.id, email: user.email })
    c.var.setSessionCookie(token)
    return c.json({ user: { id: user.id, email: user.email } })
  },
)

app.post("/api/auth/signout", (c) => {
  c.var.clearSessionCookie()
  return c.json({ ok: true })
})

app.get("/api/auth/me", (c) => {
  const u = c.get("user")
  if (!u) return c.json({ user: null })
  return c.json({ user: u })
})

app.route("/api/sync", syncApp)

export default app
