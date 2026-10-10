// 서비스 통합 테스트(모의 PayPal): 시드→분류→자동 실행→서명→차단→멱등성까지 데모 시나리오 전체 흐름
import { rmSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { MockPayPal } from "../lib/paypal/mock";
import { addMessage, editAmount, getWorkspace, rejectPlan, resetWorkspace, signPlan, triageInbox, triageMessage, updateMandate } from "../lib/service";
import { forgetWorkspace } from "../lib/store";

let paypal: MockPayPal;
let id = 0;
let wsId = "";

beforeEach(() => {
  paypal = new MockPayPal();
  wsId = `svc${++id}${Date.now().toString(36)}`;
});
afterAll(() => rmSync(".data-test", { recursive: true, force: true }));

const planFor = async (seedKey: string) => {
  const ws = await getWorkspace(wsId, { paypal });
  const msg = ws.messages.find((m) => m.seedKey === seedKey)!;
  return ws.plans.find((p) => p.messageId === msg.id)!;
};

describe("demo scenario end to end", () => {
  it("seeds real PayPal objects for every order and the subscription", async () => {
    const ws = await getWorkspace(wsId, { paypal });
    expect(ws.seedError).toBeUndefined();
    expect(ws.orders.every((o) => o.paypalOrderId && o.captureId)).toBe(true);
    expect(ws.subscriptions[0].paypalSubscriptionId).toMatch(/^I-/);
    expect(paypal.calls.filter((c) => c === "orders.track")).toHaveLength(4);
  });

  it("routes the six messages to the expected verdicts", async () => {
    await triageInbox(wsId, { allowLive: false, paypal });
    expect((await planFor("late-gift")).status).toBe("executed");
    expect((await planFor("late-gift")).execution?.by).toBe("mandate");
    expect((await planFor("broken-platter")).status).toBe("awaiting_signature");
    expect((await planFor("wholesale")).status).toBe("awaiting_signature");
    expect((await planFor("pause-box")).status).toBe("executed");
    expect((await planFor("where-vase")).status).toBe("executed");
    expect((await planFor("where-vase")).execution?.kind).toBe("reply");
    expect((await planFor("refund-now")).status).toBe("needs_review");
    const ws = await getWorkspace(wsId, { paypal });
    const maya = ws.orders.find((o) => o.ref === "HP-1042")!;
    expect((await paypal.getOrderFacts(maya.paypalOrderId!)).refunded).toBe(4.8);
    expect([...paypal.subs.values()][0].status).toBe("SUSPENDED");
  });

  it("executes a countersigned refund and an invoice", async () => {
    await triageInbox(wsId, { allowLive: false, paypal });
    const platter = await planFor("broken-platter");
    await signPlan(wsId, platter.id, { paypal });
    const signed = await planFor("broken-platter");
    expect(signed.status).toBe("executed");
    expect(signed.execution?.by).toBe("seller");
    expect(signed.execution?.paypalId).toBeTruthy();

    const invoice = await planFor("wholesale");
    await signPlan(wsId, invoice.id, { paypal });
    const sent = await planFor("wholesale");
    expect(sent.execution?.paypalStatus).toBe("SENT");
    expect([...paypal.invoices.values()][0].total).toBe(1296);
  });

  it("will not sign an escalation, and needs an explicit override for review items", async () => {
    await triageInbox(wsId, { allowLive: false, paypal });
    const alex = await planFor("refund-now");
    await expect(signPlan(wsId, alex.id, { paypal })).rejects.toThrow(/Escalated/);
    await rejectPlan(wsId, alex.id);
    expect((await planFor("refund-now")).status).toBe("rejected");
    await expect(signPlan(wsId, alex.id, { paypal })).rejects.toThrow(/rejected/);
  });

  it("re-checks PayPal at signing time and refuses an over-refund", async () => {
    await triageInbox(wsId, { allowLive: false, paypal });
    const platter = await planFor("broken-platter");
    const ws = await getWorkspace(wsId, { paypal });
    const order = ws.orders.find((o) => o.ref === "HP-1051")!;
    // Someone refunds part of the order elsewhere (e.g. in the PayPal dashboard) after the plan was drafted.
    await paypal.refundCapture({ captureId: order.captureId!, amount: 50, note: "elsewhere", invoiceId: "x", requestId: "elsewhere" });
    await signPlan(wsId, platter.id, { paypal });
    const after = await planFor("broken-platter");
    expect(after.status).toBe("blocked");
    expect(after.policy.headline).toMatch(/Exceeds/);
  });

  it("lets the seller edit an amount, which re-runs the policy", async () => {
    await triageInbox(wsId, { allowLive: false, paypal });
    const platter = await planFor("broken-platter");
    await editAmount(wsId, platter.id, 500, { paypal });
    expect((await planFor("broken-platter")).status).toBe("blocked");
    await editAmount(wsId, platter.id, 64.5, { paypal });
    const edited = await planFor("broken-platter");
    expect(edited.status).toBe("awaiting_signature");
    await signPlan(wsId, platter.id, { paypal });
    const ws = await getWorkspace(wsId, { paypal });
    const order = ws.orders.find((o) => o.ref === "HP-1051")!;
    expect((await paypal.getOrderFacts(order.paypalOrderId!)).refunded).toBe(64.5);
  });

  it("uses an idempotent PayPal request id, so a retried signature cannot refund twice", async () => {
    await triageInbox(wsId, { allowLive: false, paypal });
    const platter = await planFor("broken-platter");
    await signPlan(wsId, platter.id, { paypal });
    const ws = await getWorkspace(wsId, { paypal });
    const order = ws.orders.find((o) => o.ref === "HP-1051")!;
    const again = await paypal.refundCapture({ captureId: order.captureId!, amount: 129, note: "retry", invoiceId: "x", requestId: `countersign-${wsId}-${platter.id}` });
    expect(again.refundId).toBe((await planFor("broken-platter")).execution?.paypalId);
    expect((await paypal.getOrderFacts(order.paypalOrderId!)).refunded).toBe(129);
  });

  it("follows a tighter mandate on the next message", async () => {
    await getWorkspace(wsId, { paypal });
    await updateMandate(wsId, { autoRefundMaxUsd: 2 });
    await triageInbox(wsId, { allowLive: false, paypal });
    expect((await planFor("late-gift")).status).toBe("awaiting_signature");
  });

  it("triages a message written in the demo", async () => {
    await getWorkspace(wsId, { paypal });
    const { messageId } = await addMessage(wsId, { customerKey: "tom", subject: "hold please", body: "Could you pause my subscription for a month?" });
    const ws = await triageMessage(wsId, messageId, { allowLive: false, paypal });
    const plan = ws.plans.find((p) => p.messageId === messageId)!;
    expect(plan.proposal.action).toBe("suspend_subscription");
    expect(plan.aiSource).toBe("mock");
  });

  it("reset re-seeds fresh PayPal objects and clears plans", async () => {
    await triageInbox(wsId, { allowLive: false, paypal });
    const before = (await getWorkspace(wsId, { paypal })).orders[0].paypalOrderId;
    forgetWorkspace(wsId);
    const ws = await resetWorkspace(wsId, { paypal });
    expect(ws.plans).toHaveLength(0);
    expect(ws.orders[0].paypalOrderId).not.toBe(before);
  });
});
