import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core"

export const users = sqliteTable("users",{
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("users_email_idx").on(table.email),
  ]
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

export const syosetu = sqliteTable(
  "syosetu",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    pages: integer("pages").notNull().default(0),
    plot: text("plot").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("syosetu_user_id_idx").on(table.userId, table.id),
    index("syosetu_user_updated_idx").on(table.userId, table.updatedAt),
  ],
)

export type SyosetuRow = typeof syosetu.$inferSelect
export type NewSyosetuRow = typeof syosetu.$inferInsert

export const chapter = sqliteTable(
  "chapter",
  {
    id: text("id").primaryKey(),
    syosetuId: text("syosetu_id")
      .notNull()
      .references(() => syosetu.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    page: integer("page").notNull(),
    honbun: text("honbun").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("chapter_user_id_idx").on(table.userId, table.id),
    index("chapter_user_syosetu_idx").on(table.userId, table.syosetuId),
    index("chapter_user_updated_idx").on(table.userId, table.updatedAt),
  ],
)

export type ChapterRow = typeof chapter.$inferSelect
export type NewChapterRow = typeof chapter.$inferInsert
