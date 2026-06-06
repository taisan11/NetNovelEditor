import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql"
import { createClient } from "@libsql/client"

const dbCache = new Map<string, LibSQLDatabase>()

export function makeDb(url: string, token: string): LibSQLDatabase {
  const key = `${url}::${token}`
  const cached = dbCache.get(key)
  if (cached) return cached
  const client = createClient({ url, authToken: token })
  const db = drizzle(client)
  dbCache.set(key, db)
  return db
}
