// 테스트·키 없는 로컬 실행용 모의 PayPal(샌드박스 REST 와 같은 규칙: 환불 한도·상태 전이·멱등 요청 ID)
import { PayPalError, type CardSource, type PayPalPort } from "./port";
import type { LineItem, OrderFacts, SubscriptionFacts } from "../types";

interface MockOrder {
  orderId: string;
  captureId: string;
  customId: string;
  captured: number;
  refunds: { id: string; amount: number }[];
  trackers: string[];
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}${(++counter).toString(36).toUpperCase().padStart(6, "0")}MOCK`;

export class MockPayPal implements PayPalPort {
  readonly mode = "mock" as const;
  orders = new Map<string, MockOrder>();
  byCapture = new Map<string, MockOrder>();
  subs = new Map<string, { status: string; customId: string }>();
  invoices = new Map<string, { status: string; total: number }>();
  idempotency = new Map<string, unknown>();
  calls: string[] = [];

  async createCapturedOrder(input: { ref: string; customId: string; items: LineItem[]; total: number; card: CardSource }) {
    this.calls.push("orders.create");
    const o: MockOrder = { orderId: nextId("O"), captureId: nextId("C"), customId: input.customId, captured: input.total, refunds: [], trackers: [] };
    this.orders.set(o.orderId, o);
    this.byCapture.set(o.captureId, o);
    return { orderId: o.orderId, captureId: o.captureId };
  }

  async addTracking(input: { orderId: string; captureId: string; carrier: string; trackingNumber: string }) {
    this.calls.push("orders.track");
    const o = this.orders.get(input.orderId);
    if (!o) throw new PayPalError("RESOURCE_NOT_FOUND", 404, "RESOURCE_NOT_FOUND");
    const id = `${input.captureId}-${input.trackingNumber}`;
    o.trackers.push(id);
    return { trackerId: id };
  }

  async getOrderFacts(orderId: string): Promise<OrderFacts> {
    this.calls.push("orders.get");
    const o = this.orders.get(orderId);
    if (!o) throw new PayPalError("RESOURCE_NOT_FOUND", 404, "RESOURCE_NOT_FOUND");
    return {
      orderId: o.orderId,
      status: "COMPLETED",
      customId: o.customId,
      captureId: o.captureId,
      captured: o.captured,
      refunded: Math.round(o.refunds.reduce((s, r) => s + r.amount, 0) * 100) / 100,
      trackers: o.trackers.length,
    };
  }

  async refundCapture(input: { captureId: string; amount: number; note: string; invoiceId: string; requestId: string }) {
    this.calls.push("captures.refund");
    const prior = this.idempotency.get(input.requestId) as { refundId: string; status: string } | undefined;
    if (prior) return prior;
    const o = this.byCapture.get(input.captureId);
    if (!o) throw new PayPalError("RESOURCE_NOT_FOUND", 404, "RESOURCE_NOT_FOUND");
    const refunded = o.refunds.reduce((s, r) => s + r.amount, 0);
    if (input.amount <= 0 || input.amount > o.captured - refunded + 1e-9) {
      throw new PayPalError("REFUND_AMOUNT_EXCEEDED", 422, "REFUND_AMOUNT_EXCEEDED");
    }
    const r = { id: nextId("R"), amount: input.amount };
    o.refunds.push(r);
    const out = { refundId: r.id, status: "COMPLETED" };
    this.idempotency.set(input.requestId, out);
    return out;
  }

  async createAndSendInvoice(input: { recipientEmail: string; recipientName: string; lines: LineItem[]; note: string; terms: string; requestId: string }) {
    this.calls.push("invoices.create", "invoices.send");
    const prior = this.idempotency.get(input.requestId) as { invoiceId: string; status: string; invoiceNumber: string } | undefined;
    if (prior) return prior;
    const id = nextId("INV2-");
    const total = input.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    this.invoices.set(id, { status: "SENT", total });
    const out = { invoiceId: id, status: "SENT", invoiceNumber: String(1000 + this.invoices.size) };
    this.idempotency.set(input.requestId, out);
    return out;
  }

  async ensurePlan() {
    this.calls.push("plans.ensure");
    return "P-MOCKPLAN";
  }

  async createActiveSubscription(input: { planId: string; customId: string; subscriberName: string; subscriberEmail: string; card: CardSource }) {
    this.calls.push("subscriptions.create");
    const id = nextId("I-");
    this.subs.set(id, { status: "ACTIVE", customId: input.customId });
    return { subscriptionId: id, status: "ACTIVE" };
  }

  async getSubscriptionFacts(subscriptionId: string): Promise<SubscriptionFacts> {
    this.calls.push("subscriptions.get");
    const s = this.subs.get(subscriptionId);
    if (!s) throw new PayPalError("RESOURCE_NOT_FOUND", 404, "RESOURCE_NOT_FOUND");
    return { subscriptionId, status: s.status, customId: s.customId };
  }

  async suspendSubscription(input: { subscriptionId: string; reason: string; requestId: string }) {
    this.calls.push("subscriptions.suspend");
    const s = this.subs.get(input.subscriptionId);
    if (!s) throw new PayPalError("RESOURCE_NOT_FOUND", 404, "RESOURCE_NOT_FOUND");
    if (s.status !== "ACTIVE") throw new PayPalError("SUBSCRIPTION_STATUS_INVALID", 422, "SUBSCRIPTION_STATUS_INVALID");
    s.status = "SUSPENDED";
  }
}
