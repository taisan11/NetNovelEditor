import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./server/schema.ts",
  out: "./drizzle",
  dialect: "turso",
  dbCredentials: {
    url: process.env.TURSO_URL || "",
    authToken: process.env.TURSO_TOKEN || "",
  },
})
