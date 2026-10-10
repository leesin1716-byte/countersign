// Countersign 전역 도메인 타입(고객·주문·메시지·변경안·정책 판정·감사 로그·워크스페이스)

export type Intent =
  | "late_delivery"
  | "damaged_item"
  | "wholesale_quote"
  | "pause_subscription"
  | "where_is_my_order"
  | "refund_request"
  | "other";

export type ActionType = "refund" | "invoice" | "suspend_subscription" | "reply_only" | "escalate";

export interface Customer {
  key: string;
  name: string;
  email: string;
}

export interface LineItem {
  sku?: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface CatalogItem {
  sku: string;
  name: string;
  retail: number;
  wholesale: number;
  wholesaleMinQty: number;
}

export interface Shipment {
  carrier: string;
  trackingNumber: string;
  /** Simulated carrier feed. PayPal stores the tracker; delivery scans come from the (fictional) carrier. */
  status: "in_transit" | "delivered";
  promisedBy: string;
  deliveredAt?: string;
  scans: string[];
}

export interface OrderRecord {
  ref: string;
  customerKey: string;
  items: LineItem[];
  total: number;
  placedAt: string;
  paypalOrderId?: string;
  captureId?: string;
  shipment?: Shipment;
}

export interface SubscriptionRecord {
  ref: string;
  customerKey: string;
  planName: string;
  monthlyPrice: number;
  paypalSubscriptionId?: string;
}

export interface Attachment {
  kind: "image";
  /** Public path under /public, e.g. /attachments/platter.png */
  path: string;
  alt: string;
}

export interface InboxMessage {
  id: string;
  seedKey?: string;
  customerKey: string;
  subject: string;
  body: string;
  receivedAt: string;
  attachment?: Attachment;
}

export interface Evidence {
  source: "message" | "paypal" | "carrier" | "attachment";
  text: string;
}

/** What the model proposes. Untrusted until the policy engine has checked it against PayPal facts. */
export interface Proposal {
  intent: Intent;
  action: ActionType;
  orderRef?: string | null;
  subscriptionRef?: string | null;
  refundAmount?: number | null;
  invoiceLines?: LineItem[] | null;
  invoiceTerms?: string | null;
  summary: string;
  evidence: Evidence[];
  replyDraft: string;
  riskFlags: string[];
  confidence: number;
}

export interface AgentStep {
  tool: string;
  input: Record<string, unknown>;
  output: string;
}

export interface OrderFacts {
  orderId: string;
  status: string;
  customId?: string;
  captureId?: string;
  captured: number;
  refunded: number;
  trackers: number;
}

export interface SubscriptionFacts {
  subscriptionId: string;
  status: string;
  customId?: string;
}

export interface PolicyCheck {
  rule: string;
  pass: boolean;
  detail: string;
}

export type Verdict = "auto" | "signature" | "review" | "blocked";

export interface PolicyResult {
  verdict: Verdict;
  checks: PolicyCheck[];
  /** Deterministic money figure the executor will use (never the model's arithmetic). */
  amount: number | null;
  headline: string;
}

export type PlanStatus =
  | "awaiting_signature"
  | "needs_review"
  | "blocked"
  | "executing"
  | "executed"
  | "rejected"
  | "failed";

export interface PlanExecution {
  kind: "refund" | "invoice" | "suspend" | "reply";
  paypalId?: string;
  paypalStatus?: string;
  detail?: string;
  at: string;
  by: "mandate" | "seller";
}

export interface Plan {
  id: string;
  messageId: string;
  customerKey: string;
  proposal: Proposal;
  /** Seller-edited refund amount; null means use the proposal's. */
  amountOverride: number | null;
  policy: PolicyResult;
  status: PlanStatus;
  aiSource: "live" | "cached" | "mock";
  model: string;
  trace: AgentStep[];
  createdAt: string;
  execution?: PlanExecution;
  error?: string;
}

export interface AuditEntry {
  at: string;
  actor: "agent" | "policy" | "seller" | "paypal" | "system";
  event: string;
  detail: string;
  planId?: string;
  paypalId?: string;
}

export interface Mandate {
  autoRefundMaxUsd: number;
  autoRefundMaxPct: number;
  autoSuspendSubscriptions: boolean;
  autoReplyOnly: boolean;
}

export interface Workspace {
  id: string;
  createdAt: string;
  /** The demo store's fixed "now". Seed dates, carrier scans and the agent's "today" all use it, so recorded runs stay consistent. */
  clock: string;
  paypalMode: "sandbox" | "mock";
  store: { name: string; email: string };
  catalog: CatalogItem[];
  customers: Customer[];
  orders: OrderRecord[];
  subscriptions: SubscriptionRecord[];
  messages: InboxMessage[];
  plans: Plan[];
  audit: AuditEntry[];
  mandate: Mandate;
  seedError?: string;
}
