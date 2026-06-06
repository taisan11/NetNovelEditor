import { createMiddleware } from "hono/factory"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"
import { verifySessionToken, AUTH_COOKIE } from "./auth"

export interface SessionUser {
  id: string
  email: string
}

export type SessionContext = {
  user: SessionUser | null
  setSessionCookie: (token: string) => void
  clearSessionCookie: () => void
}

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

export const session = createMiddleware<{
  Bindings: { JWT_SECRET?: string }
  Variables: SessionContext
}>(async (c, next) => {
  let resolvedUser: SessionUser | null = null
  const secret = c.env.JWT_SECRET
  const token = getCookie(c, AUTH_COOKIE)
  if (secret && token) {
    try {
      const payload = await verifySessionToken(token, secret)
      resolvedUser = { id: payload.sub, email: payload.email }
    } catch {
      resolvedUser = null
    }
  }

  c.set("user", resolvedUser)
  c.set("setSessionCookie", (jwt: string) => {
    setCookie(c, AUTH_COOKIE, jwt, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === "https:",
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    })
  })
  c.set("clearSessionCookie", () => {
    deleteCookie(c, AUTH_COOKIE, { path: "/" })
  })

  await next()
})

export const requireAuth = createMiddleware<{
  Variables: SessionContext
}>(async (c, next) => {
  const u = c.get("user")
  if (!u) return c.json({ error: "unauthorized" }, 401)
  await next()
})

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export const rateLimit = createMiddleware<{
  Bindings: { RATE_LIMITER: RateLimitBinding }
}>(async (c, next) => {
  const cookie = getCookie(c, AUTH_COOKIE)
  const rawKey = cookie && cookie.length > 0 ? cookie : "guest"
  let key: string
  try {
    key = await sha256Hex(rawKey)
  } catch {
    key = "guest"
  }
  try {
    const { success } = await c.env.RATE_LIMITER.limit({ key })
    if (!success) {
      return c.json({ error: "rate limit exceeded" }, 429)
    }
  } catch {
    await next()
    return
  }
  await next()
})
