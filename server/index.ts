import { Hono } from "hono"
import {drizzle} from "drizzle-orm/libsql"

interface Bindings {
  TURSO_URL: string
  TURSO_TOKEN: string
}

const app = new Hono<{Bindings:Bindings}>()

app.get("/", (c) => {
  const db = drizzle({connection:{url:c.env.TURSO_URL, authToken:c.env.TURSO_TOKEN}})
  return c.text("Hello, World!")
})

export default app
