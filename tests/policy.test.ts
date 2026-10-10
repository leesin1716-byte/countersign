// 정책 엔진 단위 테스트: 한도·소유권·환불 잔액·배송 증거·가격표·조작 플래그 판정
import { describe, expect, it } from "vitest";
import { evaluate, invoiceTotal } from "../lib/policy";
import { seedData } from "../lib/seed";
import type { OrderFacts, Proposal } from "../lib/types";

const ws = seedData("t1", "mock", Date.parse("2026-10-10T12:00:00Z"));
const msg = (key: string) => ws.messages.find((m) => m.seedKey === key)!;
const facts = (o: Partial<OrderFacts> = {}): { order: OrderFacts } => ({
  order: { orderId: "O1", status: "COMPLETED", customId: "t1:maya", captureId: "C1", captured: 48, refunded: 0, trackers: 1, ...o },
});
const refund = (p: Partial<Proposal> = {}): Proposal => ({
  intent: "late_delivery",
  action: "refund",
  orderRef: "HP-1042",
  refundAmount: 4.8,
  summary: "s",
  evidence: [],
  replyDraft: "r",
  riskFlags: [],
  confidence: 0.9,
  ...p,
});

describe("refunds", () => {
  it("auto-executes a small refund inside the mandate", () => {
    const r = evaluate(ws, msg("late-gift"), refund(), null, facts());
    expect(r.verdict).toBe("auto");
    expect(r.amount).toBe(4.8);
  });

  it("asks for a signature above the dollar limit", () => {
    const r = evaluate(ws, msg("broken-platter"), refund({ intent: "damaged_item", orderRef: "HP-1051", refundAmount: 129 }), null, facts({ customId: "t1:daniel", captured: 129 }));
    expect(r.verdict).toBe("signature");
  });

  it("asks for a signature above the percentage limit even when the dollars are small", () => {
    const r = evaluate(ws, msg("late-gift"), refund({ refundAmount: 9.6 }), null, facts()); // 20%
    expect(r.verdict).toBe("signature");
  });

  it("requires a signature whenever the seller edited the amount", () => {
    const r = evaluate(ws, msg("late-gift"), refund(), 3, facts());
    expect(r.verdict).toBe("signature");
    expect(r.amount).toBe(3);
  });

  it("blocks refunds beyond what PayPal still holds", () => {
    const r = evaluate(ws, msg("late-gift"), refund({ refundAmount: 10 }), null, facts({ refunded: 40 }));
    expect(r.verdict).toBe("blocked");
    expect(r.headline).toMatch(/Exceeds/);
  });

  it("blocks an order that PayPal says belongs to someone else", () => {
    const r = evaluate(ws, msg("late-gift"), refund(), null, facts({ customId: "t1:alex" }));
    expect(r.verdict).toBe("blocked");
  });

  it("blocks unknown orders and failed lookups", () => {
    expect(evaluate(ws, msg("late-gift"), refund({ orderRef: "HP-9999" }), null, {}).verdict).toBe("blocked");
    expect(evaluate(ws, msg("late-gift"), refund(), null, { lookupError: "timeout" }).verdict).toBe("blocked");
  });

  it("sends a 'never arrived' claim on a delivered order to review", () => {
    const r = evaluate(ws, msg("refund-now"), refund({ intent: "refund_request", orderRef: "HP-1038", refundAmount: 20 }), null, facts({ customId: "t1:alex", captured: 210 }));
    expect(r.verdict).toBe("review");
  });

  it("never auto-executes when the agent flagged manipulation", () => {
    const r = evaluate(ws, msg("late-gift"), refund({ riskFlags: ["prompt_injection"] }), null, facts());
    expect(r.verdict).toBe("review");
  });

  it("rejects zero or negative amounts", () => {
    expect(evaluate(ws, msg("late-gift"), refund({ refundAmount: 0 }), null, facts()).verdict).toBe("blocked");
    expect(evaluate(ws, msg("late-gift"), refund(), -5, facts()).verdict).toBe("blocked");
  });
});

describe("invoices", () => {
  const invoice = (lines: Proposal["invoiceLines"]): Proposal => ({ ...refund(), intent: "wholesale_quote", action: "invoice", orderRef: null, refundAmount: null, invoiceLines: lines });

  it("computes the total itself and always asks for a signature", () => {
    const lines = [
      { sku: "MUG-12-SPK", description: "12oz speckled mug", quantity: 40, unitPrice: 18 },
      { sku: "PLT-ASH-L", description: "Large ash-glaze serving platter", quantity: 6, unitPrice: 96 },
    ];
    const r = evaluate(ws, msg("wholesale"), invoice(lines), null, {});
    expect(r.verdict).toBe("signature");
    expect(r.amount).toBe(1296);
    expect(invoiceTotal(lines)).toBe(1296);
  });

  it("blocks wholesale prices below the minimum quantity", () => {
    const r = evaluate(ws, msg("wholesale"), invoice([{ sku: "MUG-12-SPK", description: "12oz speckled mug", quantity: 10, unitPrice: 18 }]), null, {});
    expect(r.verdict).toBe("blocked");
  });

  it("blocks items that are not in the catalog", () => {
    const r = evaluate(ws, msg("wholesale"), invoice([{ sku: "GIFT-CARD", description: "Gift card", quantity: 1, unitPrice: 500 }]), null, {});
    expect(r.verdict).toBe("blocked");
  });
});

describe("subscriptions and replies", () => {
  const pause: Proposal = { ...refund(), intent: "pause_subscription", action: "suspend_subscription", orderRef: null, refundAmount: null, subscriptionRef: "SUB-207" };

  it("auto-pauses an active subscription owned by the sender", () => {
    const r = evaluate(ws, msg("pause-box"), pause, null, { subscription: { subscriptionId: "I-1", status: "ACTIVE", customId: "t1:tom" } });
    expect(r.verdict).toBe("auto");
  });

  it("blocks pausing a subscription that is not active", () => {
    const r = evaluate(ws, msg("pause-box"), pause, null, { subscription: { subscriptionId: "I-1", status: "SUSPENDED", customId: "t1:tom" } });
    expect(r.verdict).toBe("blocked");
  });

  it("needs a signature when the mandate turns auto-pause off", () => {
    const strict = { ...ws, mandate: { ...ws.mandate, autoSuspendSubscriptions: false } };
    const r = evaluate(strict, msg("pause-box"), pause, null, { subscription: { subscriptionId: "I-1", status: "ACTIVE", customId: "t1:tom" } });
    expect(r.verdict).toBe("signature");
  });

  it("lets reply-only items through and holds escalations", () => {
    expect(evaluate(ws, msg("where-vase"), { ...refund(), action: "reply_only" }, null, {}).verdict).toBe("auto");
    expect(evaluate(ws, msg("refund-now"), { ...refund(), action: "escalate" }, null, {}).verdict).toBe("review");
  });
});
