import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { and, eq, gt, inArray } from "drizzle-orm"
import { syosetu, chapter, type SyosetuRow, type ChapterRow } from "./schema"
import { requireAuth, type SessionContext } from "./middleware"
import { makeDb } from "./db"
import {
  MAX_TITLE_LENGTH,
  MAX_HONBUN_LENGTH,
  MAX_PLOT_LENGTH,
  PUSH_BODY_MAX_BYTES,
} from "./limits"

interface Bindings {
  TURSO_URL: string
  TURSO_TOKEN: string
}

interface SyosetuPayload {
  id: string
  title: string
  pages: number
  plot: string
  createdAt: number
  updatedAt: number
  deleted: boolean
}

interface ChapterPayload {
  id: string
  syosetuId: string
  title: string
  page: number
  honbun: string
  createdAt: number
  updatedAt: number
  deleted: boolean
  allowEmptyHonbun?: boolean
}

interface PushBody {
  syosetu: SyosetuPayload[]
  chapters: ChapterPayload[]
}

interface PushResultEntry {
  id: string
  winner: "client" | "server"
  server?: SyosetuPayload | ChapterPayload
}

function toMs(value: number | Date): Date {
  return value instanceof Date ? value : new Date(value)
}

function jsonError(message: string, status: 400 | 401 | 500 = 400) {
  return { error: message, status }
}

function asSyosetuPayload(row: SyosetuRow): SyosetuPayload {
  return {
    id: row.id,
    title: row.title,
    pages: row.pages,
    plot: row.plot,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    deleted: row.deleted,
  }
}

function asChapterPayload(row: ChapterRow): ChapterPayload {
  return {
    id: row.id,
    syosetuId: row.syosetuId,
    title: row.title,
    page: row.page,
    honbun: row.honbun,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    deleted: row.deleted,
  }
}

const app = new Hono<{ Bindings: Bindings; Variables: SessionContext }>()

app.use("/*", requireAuth)

app.get("/snapshot", async (c) => {
  const db = makeDb(c.env.TURSO_URL, c.env.TURSO_TOKEN)
  const user = c.get("user")!

  const sinceParam = c.req.query("since")
  const since = sinceParam ? Number(sinceParam) : NaN
  const hasSince = Number.isFinite(since) && since >= 0

  const sWhere = hasSince
    ? and(eq(syosetu.userId, user.id), gt(syosetu.updatedAt, toMs(since)))
    : eq(syosetu.userId, user.id)
  const cWhere = hasSince
    ? and(eq(chapter.userId, user.id), gt(chapter.updatedAt, toMs(since)))
    : eq(chapter.userId, user.id)

  const [sRows, cRows] = await Promise.all([
    db.select().from(syosetu).where(sWhere),
    db.select().from(chapter).where(cWhere),
  ])

  return c.json({
    syosetu: sRows.map(asSyosetuPayload),
    chapters: cRows.map(asChapterPayload),
    serverTime: Date.now(),
  })
})

app.delete("/chapter/:id", async (c) => {
  const user = c.get("user")!
  const id = c.req.param("id")
  const db = makeDb(c.env.TURSO_URL, c.env.TURSO_TOKEN)
  const existing = await db
    .select()
    .from(chapter)
    .where(and(eq(chapter.userId, user.id), eq(chapter.id, id)))
    .limit(1)

  if (existing.length === 0) return c.json({ ok: true, deleted: false })

  const deletedAt = Date.now()
  await db
    .update(chapter)
    .set({ deleted: true, updatedAt: toMs(deletedAt) })
    .where(and(eq(chapter.userId, user.id), eq(chapter.id, id)))

  return c.json({ ok: true, deleted: true, updatedAt: deletedAt })
})

app.delete("/syosetu/:id", async (c) => {
  const user = c.get("user")!
  const id = c.req.param("id")
  const db = makeDb(c.env.TURSO_URL, c.env.TURSO_TOKEN)
  const existing = await db
    .select()
    .from(syosetu)
    .where(and(eq(syosetu.userId, user.id), eq(syosetu.id, id)))
    .limit(1)

  if (existing.length === 0) return c.json({ ok: true, deleted: false })

  const deletedAt = Date.now()
  await db.transaction(async (tx) => {
    await tx
      .update(chapter)
      .set({ deleted: true, updatedAt: toMs(deletedAt) })
      .where(and(eq(chapter.userId, user.id), eq(chapter.syosetuId, id)))
    await tx
      .update(syosetu)
      .set({ deleted: true, updatedAt: toMs(deletedAt) })
      .where(and(eq(syosetu.userId, user.id), eq(syosetu.id, id)))
  })

  return c.json({ ok: true, deleted: true, updatedAt: deletedAt })
})

app.post(
  "/syosetu",
  bodyLimit({
    maxSize: MAX_HONBUN_LENGTH * 2,
    onError: (c) => c.json({ error: "request body too large" }, 413),
  }),
  async (c) => {
    const user = c.get("user")!
    const body = (await c.req.json().catch(() => null)) as SyosetuPayload | null
    if (!body) return c.json(jsonError("リクエストボディが不正です"), 400)
    if (typeof body.id !== "string" || !body.id)
      return c.json(jsonError("id は必須です"), 400)
    if (typeof body.title !== "string" || !body.title)
      return c.json(jsonError("title は必須です"), 400)
    if (body.title.length > MAX_TITLE_LENGTH)
      return c.json(jsonError(`title は ${MAX_TITLE_LENGTH} 文字以内で指定してください`), 400)
    if (typeof body.plot === "string" && body.plot.length > MAX_PLOT_LENGTH)
      return c.json(jsonError(`plot は ${MAX_PLOT_LENGTH} 文字以内で指定してください`), 400)
    if (typeof body.updatedAt !== "number")
      return c.json(jsonError("updatedAt は必須です"), 400)

    const db = makeDb(c.env.TURSO_URL, c.env.TURSO_TOKEN)

    const existing = await db
      .select()
      .from(syosetu)
      .where(and(eq(syosetu.userId, user.id), eq(syosetu.id, body.id)))
      .limit(1)

    const now = Date.now()
    const clientUpdated = body.updatedAt

    if (existing.length === 0) {
      await db.insert(syosetu).values({
        id: body.id,
        userId: user.id,
        title: body.title,
        pages: body.pages ?? 0,
        plot: body.plot ?? "",
        createdAt: toMs(body.createdAt ?? now),
        updatedAt: toMs(clientUpdated),
        deleted: !!body.deleted,
      })
      return c.json({ ok: true, winner: "client", appliedAt: now })
    }

    const row = existing[0]
    if (clientUpdated <= row.updatedAt.getTime()) {
      return c.json({
        ok: true,
        winner: "server",
        appliedAt: row.updatedAt.getTime(),
        server: asSyosetuPayload(row),
      })
    }

    await db
      .update(syosetu)
      .set({
        title: body.title,
        pages: body.pages ?? row.pages,
        plot: body.plot ?? row.plot,
        updatedAt: toMs(clientUpdated),
        deleted: !!body.deleted,
      })
      .where(and(eq(syosetu.userId, user.id), eq(syosetu.id, body.id)))

    return c.json({ ok: true, winner: "client", appliedAt: clientUpdated })
  },
)

app.post(
  "/chapter",
  bodyLimit({
    maxSize: MAX_HONBUN_LENGTH * 2,
    onError: (c) => c.json({ error: "request body too large" }, 413),
  }),
  async (c) => {
    const user = c.get("user")!
    const body = (await c.req.json().catch(() => null)) as ChapterPayload | null
    if (!body) return c.json(jsonError("リクエストボディが不正です"), 400)
    if (typeof body.id !== "string" || !body.id)
      return c.json(jsonError("id は必須です"), 400)
    if (typeof body.syosetuId !== "string" || !body.syosetuId)
      return c.json(jsonError("syosetuId は必須です"), 400)
    if (typeof body.title !== "string" || !body.title)
      return c.json(jsonError("title は必須です"), 400)
    if (body.title.length > MAX_TITLE_LENGTH)
      return c.json(jsonError(`title は ${MAX_TITLE_LENGTH} 文字以内で指定してください`), 400)
    if (typeof body.honbun === "string" && body.honbun.length > MAX_HONBUN_LENGTH)
      return c.json(jsonError(`honbun は ${MAX_HONBUN_LENGTH} 文字以内で指定してください`), 400)
    if (typeof body.updatedAt !== "number")
      return c.json(jsonError("updatedAt は必須です"), 400)

    const db = makeDb(c.env.TURSO_URL, c.env.TURSO_TOKEN)

    const parent = await db
      .select()
      .from(syosetu)
      .where(and(eq(syosetu.userId, user.id), eq(syosetu.id, body.syosetuId)))
      .limit(1)
    if (parent.length === 0) {
      return c.json(jsonError("紐づく作品が見つかりません"), 400)
    }

    const existing = await db
      .select()
      .from(chapter)
      .where(and(eq(chapter.userId, user.id), eq(chapter.id, body.id)))
      .limit(1)

    const now = Date.now()
    const clientUpdated = body.updatedAt

    if (existing.length === 0) {
      await db.insert(chapter).values({
        id: body.id,
        syosetuId: body.syosetuId,
        userId: user.id,
        title: body.title,
        page: body.page,
        honbun: body.honbun ?? "",
        createdAt: toMs(body.createdAt ?? now),
        updatedAt: toMs(clientUpdated),
        deleted: !!body.deleted,
      })
      return c.json({ ok: true, winner: "client", appliedAt: now })
    }

    const row = existing[0]
    if (clientUpdated <= row.updatedAt.getTime()) {
      return c.json({
        ok: true,
        winner: "server",
        appliedAt: row.updatedAt.getTime(),
        server: asChapterPayload(row),
      })
    }

    if (body.honbun === "" && row.honbun !== "" && body.allowEmptyHonbun !== true) {
      return c.json({
        ok: true,
        winner: "server",
        appliedAt: row.updatedAt.getTime(),
        server: asChapterPayload(row),
      })
    }

    await db
      .update(chapter)
      .set({
        syosetuId: body.syosetuId,
        title: body.title,
        page: body.page,
        honbun: body.honbun ?? row.honbun,
        updatedAt: toMs(clientUpdated),
        deleted: !!body.deleted,
      })
      .where(and(eq(chapter.userId, user.id), eq(chapter.id, body.id)))

    return c.json({ ok: true, winner: "client", appliedAt: clientUpdated })
  },
)

app.post(
  "/push",
  bodyLimit({
    maxSize: PUSH_BODY_MAX_BYTES,
    onError: (c) => c.json({ error: "request body too large" }, 413),
  }),
  async (c) => {
    const user = c.get("user")!
    const body = (await c.req.json().catch(() => null)) as PushBody | null
    if (!body) return c.json(jsonError("リクエストボディが不正です"), 400)
    if (!Array.isArray(body.syosetu) || !Array.isArray(body.chapters)) {
      return c.json(jsonError("syosetu/chapters は配列で指定してください"), 400)
    }

    for (const s of body.syosetu) {
      if (typeof s.id !== "string" || typeof s.updatedAt !== "number") continue
      if (typeof s.title === "string" && s.title.length > MAX_TITLE_LENGTH)
        return c.json(jsonError(`syosetu.title は ${MAX_TITLE_LENGTH} 文字以内で指定してください`), 400)
      if (typeof s.plot === "string" && s.plot.length > MAX_PLOT_LENGTH)
        return c.json(jsonError(`syosetu.plot は ${MAX_PLOT_LENGTH} 文字以内で指定してください`), 400)
    }
    for (const ch of body.chapters) {
      if (typeof ch.id !== "string" || typeof ch.updatedAt !== "number") continue
      if (typeof ch.title === "string" && ch.title.length > MAX_TITLE_LENGTH)
        return c.json(jsonError(`chapter.title は ${MAX_TITLE_LENGTH} 文字以内で指定してください`), 400)
      if (typeof ch.honbun === "string" && ch.honbun.length > MAX_HONBUN_LENGTH)
        return c.json(jsonError(`chapter.honbun は ${MAX_HONBUN_LENGTH} 文字以内で指定してください`), 400)
    }

    const db = makeDb(c.env.TURSO_URL, c.env.TURSO_TOKEN)

    const sResults: PushResultEntry[] = []
    const cResults: PushResultEntry[] = []

    await db.transaction(async (tx) => {
      const syosetuIds = body.syosetu
        .map((s) => s.id)
        .filter((id): id is string => typeof id === "string")
      const existingSyosetuRows =
        syosetuIds.length > 0
          ? await tx
              .select()
              .from(syosetu)
              .where(and(eq(syosetu.userId, user.id), inArray(syosetu.id, syosetuIds)))
          : []
      const existingSyosetuMap = new Map(existingSyosetuRows.map((r) => [r.id, r]))

      for (const s of body.syosetu) {
        if (typeof s.id !== "string" || typeof s.updatedAt !== "number") continue
        const existing = existingSyosetuMap.get(s.id)
        if (!existing) {
          await tx.insert(syosetu).values({
            id: s.id,
            userId: user.id,
            title: s.title,
            pages: s.pages ?? 0,
            plot: s.plot ?? "",
            createdAt: toMs(s.createdAt ?? s.updatedAt),
            updatedAt: toMs(s.updatedAt),
            deleted: !!s.deleted,
          })
          sResults.push({ id: s.id, winner: "client" })
        } else if (s.updatedAt > existing.updatedAt.getTime()) {
          await tx
            .update(syosetu)
            .set({
              title: s.title,
              pages: s.pages ?? existing.pages,
              plot: s.plot ?? existing.plot,
              updatedAt: toMs(s.updatedAt),
              deleted: !!s.deleted,
            })
            .where(and(eq(syosetu.userId, user.id), eq(syosetu.id, s.id)))
          sResults.push({ id: s.id, winner: "client" })
        } else {
          sResults.push({
            id: s.id,
            winner: "server",
            server: asSyosetuPayload(existing),
          })
        }
      }

      if (body.chapters.length > 0) {
        const ids = body.chapters
          .map((c) => c.id)
          .filter((id): id is string => typeof id === "string")
        const parentIds = Array.from(
          new Set(
            body.chapters
              .map((c) => c.syosetuId)
              .filter((id): id is string => typeof id === "string"),
          ),
        )
        if (parentIds.length > 0) {
          const parents = await tx
            .select({ id: syosetu.id })
            .from(syosetu)
            .where(
              and(eq(syosetu.userId, user.id), inArray(syosetu.id, parentIds)),
            )
          const parentSet = new Set(parents.map((p) => p.id))
          const existingChapters =
            ids.length > 0
              ? await tx
                  .select()
                  .from(chapter)
                  .where(and(eq(chapter.userId, user.id), inArray(chapter.id, ids)))
              : []
          const existingMap = new Map(existingChapters.map((r) => [r.id, r]))

          for (const ch of body.chapters) {
            if (typeof ch.id !== "string" || typeof ch.updatedAt !== "number") continue
            if (!parentSet.has(ch.syosetuId)) continue
            const existing = existingMap.get(ch.id)
            if (!existing) {
              await tx.insert(chapter).values({
                id: ch.id,
                syosetuId: ch.syosetuId,
                userId: user.id,
                title: ch.title,
                page: ch.page,
                honbun: ch.honbun ?? "",
                createdAt: toMs(ch.createdAt ?? ch.updatedAt),
                updatedAt: toMs(ch.updatedAt),
                deleted: !!ch.deleted,
              })
              cResults.push({ id: ch.id, winner: "client" })
            } else if (ch.updatedAt > existing.updatedAt.getTime()) {
              if (ch.honbun === "" && existing.honbun !== "" && ch.allowEmptyHonbun !== true) {
                cResults.push({
                  id: ch.id,
                  winner: "server",
                  server: asChapterPayload(existing),
                })
                continue
              }
              await tx
                .update(chapter)
                .set({
                  syosetuId: ch.syosetuId,
                  title: ch.title,
                  page: ch.page,
                  honbun: ch.honbun ?? existing.honbun,
                  updatedAt: toMs(ch.updatedAt),
                  deleted: !!ch.deleted,
                })
                .where(
                  and(eq(chapter.userId, user.id), eq(chapter.id, ch.id)),
                )
              cResults.push({ id: ch.id, winner: "client" })
            } else {
              cResults.push({
                id: ch.id,
                winner: "server",
                server: asChapterPayload(existing),
              })
            }
          }
        }
      }
    })

    return c.json({ ok: true, results: { syosetu: sResults, chapters: cResults } })
  },
)

export default app
