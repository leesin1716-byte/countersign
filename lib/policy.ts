// 결정적 정책 엔진: AI 변경안을 PayPal 사실과 위임 한도로 검사해 자동 실행·서명 필요·검토·차단을 판정한다
import type {
  InboxMessage,
  LineItem,
  OrderFacts,
  PolicyCheck,
  PolicyResult,
  Proposal,
  SubscriptionFacts,
  Verdict,
  Workspace,
} from "./types";

export interface Facts {
  order?: OrderFacts | null;
  subscription?: SubscriptionFacts | null;
  lookupError?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const usd = (n: number) => `$${n.toFixed(2)}`;

export function invoiceTotal(lines: LineItem[]): number {
  return round2(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0));
}

const INVOICE_CEILING = 10_000;
const NON_RECEIPT_INTENTS = new Set(["where_is_my_order", "refund_request"]);

export function evaluate(
  ws: Workspace,
  message: InboxMessage,
  proposal: Proposal,
  amountOverride: number | null,
  facts: Facts,
): PolicyResult {
  const checks: PolicyCheck[] = [];
  const check = (rule: string, pass: boolean, detail: string) => {
    checks.push({ rule, pass, detail });
    return pass;
  };
  const result = (verdict: Verdict, amount: number | null, headline: string): PolicyResult => ({ verdict, checks, amount, headline });
  const injection = proposal.riskFlags.some((f) => /inject|manipulat|policy.?override/i.test(f));
  const ownerTag = `${ws.id}:${message.customerKey}`;

  switch (proposal.action) {
    case "refund": {
      const order = ws.orders.find((o) => o.ref === proposal.orderRef);
      if (!check("Order exists in this store", !!order, order ? `${order.ref} found` : `No order ${proposal.orderRef ?? "(none)"}`)) {
        return result("blocked", null, "Unknown order");
      }
      const f = facts.order;
      if (!check("PayPal order is readable", !!f, f ? `PayPal order ${f.orderId} is ${f.status}` : facts.lookupError ?? "PayPal lookup failed")) {
        return result("blocked", null, "PayPal lookup failed");
      }
      if (!check("Order belongs to the sender", f!.customId === ownerTag, f!.customId === ownerTag ? "PayPal custom_id matches the sender" : "PayPal custom_id belongs to someone else")) {
        return result("blocked", null, "Order belongs to another customer");
      }
      const remaining = round2(f!.captured - f!.refunded);
      const amount = round2(amountOverride ?? proposal.refundAmount ?? 0);
      if (!check("Amount is positive", amount > 0, usd(amount))) return result("blocked", amount, "Refund amount must be positive");
      if (!check("Within refundable balance", amount <= remaining, `${usd(amount)} of ${usd(remaining)} still refundable (captured ${usd(f!.captured)}, refunded ${usd(f!.refunded)})`)) {
        return result("blocked", amount, "Exceeds what PayPal can refund");
      }
      const pct = f!.captured > 0 ? (amount / f!.captured) * 100 : 100;
      const delivered = order!.shipment?.status === "delivered";
      const hasPhoto = !!message.attachment;
      const nonReceiptClaim = NON_RECEIPT_INTENTS.has(proposal.intent) && delivered && !hasPhoto;
      check(
        "Delivery evidence is consistent",
        !nonReceiptClaim,
        nonReceiptClaim ? `Carrier shows delivered ${order!.shipment?.deliveredAt?.slice(0, 10)} and no evidence was supplied` : delivered ? "Delivered; claim is about condition or timing" : "Not yet delivered",
      );
      check("No manipulation flags", !injection, injection ? `Agent flagged: ${proposal.riskFlags.join(", ")}` : "None");
      const withinMandate = amount <= ws.mandate.autoRefundMaxUsd && pct <= ws.mandate.autoRefundMaxPct + 1e-9;
      check(
        "Within mandate",
        withinMandate,
        `${usd(amount)} (${pct.toFixed(1)}%) vs mandate ${usd(ws.mandate.autoRefundMaxUsd)} / ${ws.mandate.autoRefundMaxPct}%`,
      );
      if (nonReceiptClaim || injection) return result("review", amount, nonReceiptClaim ? "Carrier says delivered - human review" : "Possible manipulation - human review");
      if (withinMandate && amountOverride === null) return result("auto", amount, `Refund ${usd(amount)} within mandate`);
      return result("signature", amount, `Refund ${usd(amount)} needs your countersignature`);
    }

    case "invoice": {
      const lines = proposal.invoiceLines ?? [];
      if (!check("Has invoice lines", lines.length > 0, `${lines.length} line(s)`)) return result("blocked", null, "Empty invoice");
      let pricesOk = true;
      for (const l of lines) {
        const item = ws.catalog.find((c) => c.sku === l.sku) ?? ws.catalog.find((c) => c.name.toLowerCase() === l.description.toLowerCase());
        const floor = item ? (l.quantity >= item.wholesaleMinQty ? item.wholesale : item.retail) : null;
        const ok = !!item && Number.isInteger(l.quantity) && l.quantity > 0 && floor !== null && l.unitPrice >= floor - 1e-9;
        pricesOk &&= ok;
        check(
          `Price list: ${l.description}`,
          ok,
          !item ? "Not in the catalog" : `${l.quantity} x ${usd(l.unitPrice)} (price list ${usd(floor!)} at this quantity)`,
        );
      }
      const total = invoiceTotal(lines);
      const underCeiling = check("Under invoice ceiling", total <= INVOICE_CEILING, `${usd(total)} vs ${usd(INVOICE_CEILING)}`);
      if (!pricesOk || !underCeiling) return result("blocked", total, "Invoice does not match the price list");
      check("Seller signs every invoice", true, "The mandate never auto-sends invoices");
      return result("signature", total, `Invoice ${usd(total)} ready to send`);
    }

    case "suspend_subscription": {
      const sub = ws.subscriptions.find((s) => s.ref === proposal.subscriptionRef);
      if (!check("Subscription exists", !!sub, sub ? `${sub.ref} (${sub.planName})` : `No subscription ${proposal.subscriptionRef ?? "(none)"}`)) {
        return result("blocked", null, "Unknown subscription");
      }
      const f = facts.subscription;
      if (!check("PayPal subscription is readable", !!f, f ? `PayPal ${f.subscriptionId} is ${f.status}` : facts.lookupError ?? "PayPal lookup failed")) {
        return result("blocked", null, "PayPal lookup failed");
      }
      if (!check("Subscription belongs to the sender", f!.customId === ownerTag, f!.customId === ownerTag ? "PayPal custom_id matches the sender" : "Belongs to someone else")) {
        return result("blocked", null, "Subscription belongs to another customer");
      }
      if (!check("Subscription is active", f!.status === "ACTIVE", f!.status)) return result("blocked", null, `Subscription is ${f!.status}`);
      check("No manipulation flags", !injection, injection ? proposal.riskFlags.join(", ") : "None");
      const auto = ws.mandate.autoSuspendSubscriptions && !injection;
      check("Within mandate", auto, ws.mandate.autoSuspendSubscriptions ? "Mandate allows pausing on request" : "Mandate requires a signature to pause");
      return result(auto ? "auto" : "signature", null, auto ? "Pause within mandate" : "Pause needs your countersignature");
    }

    case "reply_only": {
      check("No money moves", true, "Reply draft only");
      const auto = ws.mandate.autoReplyOnly && !injection;
      return result(auto ? "auto" : "signature", null, "Reply drafted - no PayPal change");
    }

    case "escalate":
    default: {
      check("Agent asked for a human", true, proposal.riskFlags.join(", ") || "Escalated");
      return result("review", null, "Needs your review - nothing will move");
    }
  }
}
