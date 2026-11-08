import { createClient, type Client } from "@libsql/client";
import type { PlanId } from "../shared/plans";

export async function setAccountPlan(client: Client, userId: string, plan: PlanId): Promise<void> {
  if (plan !== "free" && plan !== "pro") throw new Error("プランは free または pro を指定してください");
  const result = await client.execute({
    sql: `INSERT INTO account_plans (user_id, plan)
      SELECT id, ? FROM users WHERE id = ?
      ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan`,
    args: [plan, userId],
  });
  if (result.rowsAffected === 0) throw new Error("指定したユーザーが見つかりません");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const userId = option("--user");
  const plan = option("--plan");
  if (!userId || (plan !== "free" && plan !== "pro")) {
    throw new Error("使用法: bun run plan:set --user <ユーザーID> --plan <free|pro> --confirm");
  }
  const url = process.env.TURSO_URL;
  if (!url) throw new Error("TURSO_URL を設定してください");
  if (!args.includes("--confirm")) throw new Error("対象DB・ユーザーIDを確認し、--confirm を付けて実行してください");
  const client = createClient({ url, authToken: process.env.TURSO_TOKEN });
  try {
    await setAccountPlan(client, userId, plan);
    console.log(`ユーザー ${userId} のプランを ${plan} に変更しました。`);
  } finally {
    client.close();
  }
}
