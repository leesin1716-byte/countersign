// 화면 표시용 서식 함수(금액·상대 시간·상태 라벨)
import type { Plan, PlanStatus, Verdict, Workspace } from "@/lib/types";

export const usd = (n: number | null | undefined) => (n === null || n === undefined ? "-" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export const time = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export const VERDICT_LABEL: Record<Verdict, string> = {
  auto: "Inside mandate",
  signature: "Needs signature",
  review: "Needs review",
  blocked: "Blocked",
};

export function statusLabel(p: Plan): string {
  const map: Record<PlanStatus, string> = {
    awaiting_signature: "Awaiting signature",
    needs_review: "Needs review",
    blocked: "Blocked by policy",
    executing: "Executing",
    executed: p.execution?.by === "mandate" ? "Done by mandate" : "Countersigned",
    rejected: "Rejected",
    failed: "PayPal error",
  };
  return map[p.status];
}

export function statusTone(s: PlanStatus): "ok" | "wait" | "warn" | "bad" | "mute" {
  if (s === "executed") return "ok";
  if (s === "awaiting_signature" || s === "executing") return "wait";
  if (s === "needs_review") return "warn";
  if (s === "blocked" || s === "failed") return "bad";
  return "mute";
}

export const ACTION_LABEL = {
  refund: "Refund",
  invoice: "Invoice",
  suspend_subscription: "Pause subscription",
  reply_only: "Reply only",
  escalate: "Escalate",
} as const;

export const INTENT_LABEL: Record<string, string> = {
  late_delivery: "Late delivery",
  damaged_item: "Damaged item",
  wholesale_quote: "Wholesale quote",
  pause_subscription: "Pause request",
  where_is_my_order: "Where is my order",
  refund_request: "Refund demand",
  other: "Other",
};

export const customerName = (ws: Workspace, key: string) => ws.customers.find((c) => c.key === key)?.name ?? key;
