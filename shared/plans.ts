export type PlanId = "free" | "pro";

export const PLANS = {
  free: { name: "無料", maxWorks: 10, maxStorageBytes: 10 * 1024 * 1024 },
  pro: { name: "Pro", maxWorks: 1_000, maxStorageBytes: 1024 * 1024 * 1024 },
} satisfies Record<PlanId, { name: string; maxWorks: number; maxStorageBytes: number }>;

export interface CloudUsage {
  works: number;
  storageBytes: number;
}

export interface PlanInfo {
  id: PlanId;
  usage: CloudUsage;
}

export function formatStorageBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
