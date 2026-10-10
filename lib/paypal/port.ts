// PayPal 연동 계층의 공통 인터페이스(실제 샌드박스 REST 와 테스트용 모의 구현이 함께 따른다)
import type { LineItem, OrderFacts, SubscriptionFacts } from "../types";

export interface CardSource {
  number: string;
  expiry: string;
  securityCode: string;
  name: string;
}

export interface PayPalPort {
  readonly mode: "sandbox" | "mock";
  /** Creates an order paid with a sandbox test card and returns the capture. */
  createCapturedOrder(input: {
    ref: string;
    customId: string;
    items: LineItem[];
    total: number;
    card: CardSource;
  }): Promise<{ orderId: string; captureId: string }>;
  addTracking(input: {
    orderId: string;
    captureId: string;
    carrier: string;
    trackingNumber: string;
  }): Promise<{ trackerId: string }>;
  getOrderFacts(orderId: string): Promise<OrderFacts>;
  refundCapture(input: {
    captureId: string;
    amount: number;
    note: string;
    invoiceId: string;
    requestId: string;
  }): Promise<{ refundId: string; status: string }>;
  createAndSendInvoice(input: {
    recipientEmail: string;
    recipientName: string;
    lines: LineItem[];
    note: string;
    terms: string;
    requestId: string;
  }): Promise<{ invoiceId: string; status: string; invoiceNumber?: string }>;
  ensurePlan(input: { productName: string; planName: string; monthlyPrice: number }): Promise<string>;
  createActiveSubscription(input: {
    planId: string;
    customId: string;
    subscriberName: string;
    subscriberEmail: string;
    card: CardSource;
  }): Promise<{ subscriptionId: string; status: string }>;
  getSubscriptionFacts(subscriptionId: string): Promise<SubscriptionFacts>;
  suspendSubscription(input: { subscriptionId: string; reason: string; requestId: string }): Promise<void>;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly issue?: string,
    public readonly debugId?: string,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

export function money(n: number): string {
  return n.toFixed(2);
}
