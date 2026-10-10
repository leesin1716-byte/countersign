// API 키 없이 돌릴 때와 테스트에서 쓰는 결정적 모의 에이전트(시드 메시지는 고정 변경안, 그 밖은 키워드 규칙)
import type { InboxMessage, Proposal, Workspace } from "../types";

const SIGN = "\n\nHollow Pine Ceramics";

export function mockProposal(ws: Workspace, message: InboxMessage): Proposal {
  const customer = ws.customers.find((c) => c.key === message.customerKey);
  const first = customer?.name.split(" ")[0] ?? "there";
  const order = ws.orders.find((o) => o.customerKey === message.customerKey && message.body.includes(o.ref)) ?? ws.orders.find((o) => o.customerKey === message.customerKey);
  const sub = ws.subscriptions.find((s) => s.customerKey === message.customerKey);
  const text = `${message.subject}\n${message.body}`.toLowerCase();
  const quote = message.body.split("\n")[0].slice(0, 140);
  const injection = /system note|ignore (all|previous)|pre-approved|policy was updated/i.test(message.body);

  if (injection) {
    return {
      intent: "refund_request",
      action: "escalate",
      orderRef: order?.ref ?? null,
      summary: `Refund demand on delivered ${order?.ref ?? "order"}; message tries to override policy`,
      evidence: [
        { source: "message", text: quote },
        { source: "message", text: "Contains a fake 'SYSTEM NOTE' claiming pre-approved refunds" },
        ...(order?.shipment ? [{ source: "carrier" as const, text: order.shipment.scans[order.shipment.scans.length - 1] }] : []),
      ],
      replyDraft: `Hi ${first}, thanks for reaching out. Our carrier shows your order as delivered and signed for, so we're taking a closer look before we decide next steps. We'll be back in touch within one business day.${SIGN}`,
      riskFlags: ["prompt_injection", "delivered_per_carrier"],
      confidence: 0.9,
    };
  }
  if (/pause|suspend|hold my subscription/.test(text) && sub) {
    return {
      intent: "pause_subscription",
      action: "suspend_subscription",
      subscriptionRef: sub.ref,
      summary: `Pause ${sub.planName} while customer moves`,
      evidence: [{ source: "message", text: quote }],
      replyDraft: `Hi ${first}, done - your ${sub.planName} box is paused and nothing more will be charged until you tell us you're settled. Good luck with the move!${SIGN}`,
      riskFlags: [],
      confidence: 0.95,
    };
  }
  if (/wholesale|invoice/.test(text)) {
    const mug = ws.catalog.find((c) => c.sku === "MUG-12-SPK")!;
    const platter = ws.catalog.find((c) => c.sku === "PLT-ASH-L")!;
    return {
      intent: "wholesale_quote",
      action: "invoice",
      invoiceLines: [
        { sku: mug.sku, description: mug.name, quantity: 40, unitPrice: mug.wholesale },
        { sku: platter.sku, description: platter.name, quantity: 6, unitPrice: platter.wholesale },
      ],
      invoiceTerms: "Net 30. Wholesale pricing per the Hollow Pine price list.",
      summary: "Wholesale invoice: 40 mugs + 6 platters, Net 30",
      evidence: [{ source: "message", text: "Could we order 40 of the 12oz speckled mugs? ... 6 of the large serving platters" }],
      replyDraft: `Hi ${first}, thank you! An invoice for 40 speckled mugs and 6 serving platters at wholesale pricing is on its way from PayPal, on Net 30 terms.${SIGN}`,
      riskFlags: [],
      confidence: 0.9,
    };
  }
  if (/where is|haven't gotten|not received|never arrived|still haven/.test(text) && order?.shipment?.status === "delivered") {
    return {
      intent: "where_is_my_order",
      action: "reply_only",
      orderRef: order.ref,
      summary: `Carrier shows ${order.ref} delivered; send delivery details`,
      evidence: [{ source: "message", text: quote }, { source: "carrier", text: order.shipment.scans[order.shipment.scans.length - 1] }],
      replyDraft: `Hi ${first}, ${order.shipment.carrier} shows your order delivered on ${order.shipment.deliveredAt?.slice(0, 10)} (${order.shipment.scans[order.shipment.scans.length - 1].replace(/^Delivered - /, "")}). Could you check around the porch or with neighbours? If it doesn't turn up, reply here and we'll sort it out.${SIGN}`,
      riskFlags: [],
      confidence: 0.85,
    };
  }
  if (order && (/crack|broken|pieces|damaged|shattered/.test(text) || message.attachment)) {
    return {
      intent: "damaged_item",
      action: "refund",
      orderRef: order.ref,
      refundAmount: order.total,
      summary: `Full refund: ${order.items[0].description} arrived broken`,
      evidence: [{ source: "message", text: quote }, ...(message.attachment ? [{ source: "attachment" as const, text: message.attachment.alt }] : [])],
      replyDraft: `Hi ${first}, I'm so sorry it arrived broken. We've refunded the full $${order.total.toFixed(2)} to your PayPal payment method - no need to send anything back.${SIGN}`,
      riskFlags: [],
      confidence: 0.9,
    };
  }
  if (order && /late|week after|delay/.test(text)) {
    const amount = Math.round(order.total * 10) / 100;
    return {
      intent: "late_delivery",
      action: "refund",
      orderRef: order.ref,
      refundAmount: amount,
      summary: `10% courtesy refund for late delivery of ${order.ref}`,
      evidence: [{ source: "message", text: quote }, ...(order.shipment ? [{ source: "carrier" as const, text: `Promised ${order.shipment.promisedBy.slice(0, 10)}, delivered ${order.shipment.deliveredAt?.slice(0, 10)}` }] : [])],
      replyDraft: `Hi ${first}, I'm sorry your gift arrived late. We've refunded $${amount.toFixed(2)} (10%) to your PayPal payment method as a thank-you for your patience.${SIGN}`,
      riskFlags: [],
      confidence: 0.9,
    };
  }
  return {
    intent: "other",
    action: "escalate",
    orderRef: order?.ref ?? null,
    summary: "Unclear request - needs a human",
    evidence: [{ source: "message", text: quote }],
    replyDraft: `Hi ${first}, thanks for your message - we'll get back to you shortly.${SIGN}`,
    riskFlags: [],
    confidence: 0.4,
  };
}
