// 서명(또는 위임 한도)으로 승인된 변경안을 PayPal 샌드박스 호출로 실행하고 결과를 다시 조회해 확인한다
import type { PayPalPort } from "./paypal/port";
import type { Facts } from "./policy";
import type { Plan, PlanExecution, Proposal, Workspace } from "./types";

export async function gatherFacts(ws: Workspace, proposal: Proposal, paypal: PayPalPort): Promise<Facts> {
  const facts: Facts = {};
  try {
    if (proposal.action === "refund" && proposal.orderRef) {
      const order = ws.orders.find((o) => o.ref === proposal.orderRef);
      if (order?.paypalOrderId) facts.order = await paypal.getOrderFacts(order.paypalOrderId);
    }
    if (proposal.action === "suspend_subscription" && proposal.subscriptionRef) {
      const sub = ws.subscriptions.find((s) => s.ref === proposal.subscriptionRef);
      if (sub?.paypalSubscriptionId) facts.subscription = await paypal.getSubscriptionFacts(sub.paypalSubscriptionId);
    }
  } catch (e) {
    facts.lookupError = e instanceof Error ? e.message : String(e);
  }
  return facts;
}

export async function execute(ws: Workspace, plan: Plan, paypal: PayPalPort, by: "mandate" | "seller"): Promise<PlanExecution> {
  const p = plan.proposal;
  const at = () => new Date().toISOString();
  const requestId = `countersign-${ws.id}-${plan.id}`;

  switch (p.action) {
    case "refund": {
      const order = ws.orders.find((o) => o.ref === p.orderRef);
      if (!order?.captureId || !order.paypalOrderId) throw new Error(`Order ${p.orderRef} has no PayPal capture`);
      const amount = plan.policy.amount;
      if (amount === null) throw new Error("Policy produced no amount");
      const r = await paypal.refundCapture({
        captureId: order.captureId,
        amount,
        note: p.summary,
        invoiceId: `${order.ref}-R-${plan.id}`.slice(0, 127),
        requestId,
      });
      // Read back from PayPal so the grid shows PayPal's truth, not ours.
      const facts = await paypal.getOrderFacts(order.paypalOrderId);
      return {
        kind: "refund",
        paypalId: r.refundId,
        paypalStatus: r.status,
        detail: `Refunded $${amount.toFixed(2)} on capture ${order.captureId}. PayPal now shows $${facts.refunded.toFixed(2)} refunded of $${facts.captured.toFixed(2)}.`,
        at: at(),
        by,
      };
    }
    case "invoice": {
      const customer = ws.customers.find((c) => c.key === plan.customerKey)!;
      const lines = p.invoiceLines ?? [];
      const inv = await paypal.createAndSendInvoice({
        recipientEmail: customer.email,
        recipientName: customer.name,
        lines,
        note: `Thank you for your order, ${customer.name.split(" ")[0]}!`,
        terms: p.invoiceTerms ?? "Net 30",
        requestId,
      });
      return {
        kind: "invoice",
        paypalId: inv.invoiceId,
        paypalStatus: inv.status,
        detail: `Invoice ${inv.invoiceNumber ?? inv.invoiceId} for $${(plan.policy.amount ?? 0).toFixed(2)} sent to ${customer.email}.`,
        at: at(),
        by,
      };
    }
    case "suspend_subscription": {
      const sub = ws.subscriptions.find((s) => s.ref === p.subscriptionRef);
      if (!sub?.paypalSubscriptionId) throw new Error(`Subscription ${p.subscriptionRef} has no PayPal id`);
      await paypal.suspendSubscription({ subscriptionId: sub.paypalSubscriptionId, reason: "Customer asked to pause", requestId });
      const facts = await paypal.getSubscriptionFacts(sub.paypalSubscriptionId);
      return { kind: "suspend", paypalId: sub.paypalSubscriptionId, paypalStatus: facts.status, detail: `${sub.planName} is now ${facts.status} in PayPal.`, at: at(), by };
    }
    case "reply_only":
      return { kind: "reply", detail: "Reply drafted. No PayPal change was needed.", at: at(), by };
    default:
      throw new Error("Escalated plans cannot be executed");
  }
}
