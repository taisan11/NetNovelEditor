import { and, eq, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { HTTPException } from "hono/http-exception";
import { accountPlans, chapter, syosetu } from "./schema";
import { PLANS, type CloudUsage, type PlanInfo } from "../shared/plans";

type Transaction = Parameters<Parameters<LibSQLDatabase["transaction"]>[0]>[0];
type Reader = Pick<LibSQLDatabase, "select">;

export async function getPlanInfo(db: Reader, userId: string): Promise<PlanInfo> {
  const [row] = await db.select().from(accountPlans).where(eq(accountPlans.userId, userId));
  return { id: row?.plan === "pro" ? "pro" : "free", usage: await getCloudUsage(db, userId) };
}

export async function getCloudUsage(db: Reader, userId: string): Promise<CloudUsage> {
  const [works] = await db.select({
    count: sql<number>`count(*)`,
    bytes: sql<number>`coalesce(sum(length(cast(${syosetu.title} as blob)) + length(cast(${syosetu.plot} as blob))), 0)`,
  }).from(syosetu).where(and(eq(syosetu.userId, userId), eq(syosetu.deleted, false)));
  const [chapters] = await db.select({
    bytes: sql<number>`coalesce(sum(length(cast(${chapter.title} as blob)) + length(cast(${chapter.honbun} as blob))), 0)`,
  }).from(chapter).innerJoin(syosetu, eq(chapter.syosetuId, syosetu.id))
    .where(and(eq(chapter.userId, userId), eq(syosetu.userId, userId), eq(chapter.deleted, false), eq(syosetu.deleted, false)));
  return { works: Number(works.count), storageBytes: Number(works.bytes) + Number(chapters.bytes) };
}

// Check the committed result, not the request size. The write transaction also
// serializes simultaneous uploads, so splitting requests cannot bypass a quota.
export async function withQuota<T>(db: LibSQLDatabase, userId: string, write: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    const before = await getPlanInfo(tx, userId);
    const result = await write(tx);
    const after = await getCloudUsage(tx, userId);
    const limits = PLANS[before.id];
    const worksExceeded = after.works > limits.maxWorks && after.works > before.usage.works;
    const bytesExceeded = after.storageBytes > limits.maxStorageBytes && after.storageBytes > before.usage.storageBytes;
    if (worksExceeded || bytesExceeded) {
      const error = worksExceeded
        ? `${limits.name}プランの作品数上限（${limits.maxWorks}作品）に達しました。クラウドの作品を削除するか、管理者にプラン変更を依頼してください。`
        : `${limits.name}プランのクラウド容量上限に達しました。データを減らすか、管理者にプラン変更を依頼してください。`;
      throw new HTTPException(403, { res: Response.json({ error, code: "PLAN_LIMIT_EXCEEDED" }, { status: 403 }) });
    }
    return result;
  });
}
