// PayPal 샌드박스 REST(Orders v2·Payments v2·Invoicing v2·Subscriptions v1)를 직접 호출하는 실제 구현
import { PayPalError, money, type CardSource, type PayPalPort } from "./port";
import type { LineItem, OrderFacts, SubscriptionFacts } from "../types";

const BASE = process.env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";

const BILLING_ADDRESS = {
  address_line_1: "2211 N First St",
  admin_area_2: "San Jose",
  admin_area_1: "CA",
  postal_code: "95131",
  country_code: "US",
};

function cardPayload(card: CardSource) {
  return {
    number: card.number,
    expiry: card.expiry,
    security_code: card.securityCode,
    name: card.name,
    billing_address: BILLING_ADDRESS,
  };
}

let cachedToken: { value: string; expiresAt: number } | null = null;
const planCache = new Map<string, string>();

export class SandboxPayPal implements PayPalPort {
  readonly mode = "sandbox" as const;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  private async token(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
    const res = await fetch(`${BASE}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalError("PayPal OAuth failed", res.status);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return json.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        // Idempotency: retrying the same plan never moves money twice.
        "PayPal-Request-Id": requestId ?? crypto.randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const issue = json?.details?.[0]?.issue ?? json?.name;
      const desc = json?.details?.[0]?.description ?? json?.message ?? "PayPal request failed";
      throw new PayPalError(`${method} ${path.split("?")[0]}: ${issue ?? res.status} - ${desc}`, res.status, issue, json?.debug_id);
    }
    return json as T;
  }

  async createCapturedOrder(input: { ref: string; customId: string; items: LineItem[]; total: number; card: CardSource }) {
    type OrderResp = { id: string; status: string; purchase_units: { payments?: { captures?: { id: string; status: string }[] } }[] };
    const order = await this.call<OrderResp>("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: input.ref,
          custom_id: input.customId,
          invoice_id: `${input.ref}-${Date.now().toString(36)}`,
          description: `Order ${input.ref}`,
          amount: {
            currency_code: "USD",
            value: money(input.total),
            breakdown: { item_total: { currency_code: "USD", value: money(input.total) } },
          },
          items: input.items.map((i) => ({
            name: i.description,
            quantity: String(i.quantity),
            unit_amount: { currency_code: "USD", value: money(i.unitPrice) },
          })),
        },
      ],
      payment_source: { card: cardPayload(input.card) },
    });
    let capture = order.purchase_units[0]?.payments?.captures?.[0];
    if (!capture) {
      const captured = await this.call<OrderResp>("POST", `/v2/checkout/orders/${order.id}/capture`, {});
      capture = captured.purchase_units[0]?.payments?.captures?.[0];
    }
    if (!capture) throw new PayPalError(`Order ${order.id} was not captured (status ${order.status})`, 422);
    return { orderId: order.id, captureId: capture.id };
  }

  async addTracking(input: { orderId: string; captureId: string; carrier: string; trackingNumber: string }) {
    type Resp = { purchase_units: { shipping?: { trackers?: { id: string }[] } }[] };
    const res = await this.call<Resp>("POST", `/v2/checkout/orders/${input.orderId}/track`, {
      capture_id: input.captureId,
      tracking_number: input.trackingNumber,
      carrier: "OTHER",
      carrier_name_other: input.carrier,
      notify_payer: false,
    });
    const trackers = res.purchase_units?.[0]?.shipping?.trackers ?? [];
    return { trackerId: trackers[trackers.length - 1]?.id ?? `${input.captureId}-${input.trackingNumber}` };
  }

  async getOrderFacts(orderId: string): Promise<OrderFacts> {
    type Amt = { value: string };
    type Resp = {
      id: string;
      status: string;
      purchase_units: {
        custom_id?: string;
        shipping?: { trackers?: unknown[] };
        payments?: { captures?: { id: string; status: string; amount: Amt }[]; refunds?: { status: string; amount: Amt }[] };
      }[];
    };
    const o = await this.call<Resp>("GET", `/v2/checkout/orders/${orderId}`);
    const pu = o.purchase_units[0] ?? {};
    const cap = pu.payments?.captures?.[0];
    let refunded = (pu.payments?.refunds ?? [])
      .filter((r) => r.status !== "FAILED" && r.status !== "CANCELLED")
      .reduce((s, r) => s + Number(r.amount.value), 0);
    if (cap && refunded === 0 && /REFUNDED/.test(cap.status)) {
      // Some sandbox responses omit the refunds array; fall back to the capture's own breakdown.
      const c = await this.call<{ seller_receivable_breakdown?: { total_refunded_amount?: Amt } }>("GET", `/v2/payments/captures/${cap.id}`);
      refunded = Number(c.seller_receivable_breakdown?.total_refunded_amount?.value ?? 0);
    }
    return {
      orderId: o.id,
      status: o.status,
      customId: pu.custom_id,
      captureId: cap?.id,
      captured: cap ? Number(cap.amount.value) : 0,
      refunded: Math.round(refunded * 100) / 100,
      trackers: pu.shipping?.trackers?.length ?? 0,
    };
  }

  async refundCapture(input: { captureId: string; amount: number; note: string; invoiceId: string; requestId: string }) {
    const r = await this.call<{ id: string; status: string }>(
      "POST",
      `/v2/payments/captures/${input.captureId}/refund`,
      {
        amount: { currency_code: "USD", value: money(input.amount) },
        invoice_id: input.invoiceId,
        note_to_payer: input.note.slice(0, 255),
      },
      input.requestId,
    );
    return { refundId: r.id, status: r.status };
  }

  async createAndSendInvoice(input: { recipientEmail: string; recipientName: string; lines: LineItem[]; note: string; terms: string; requestId: string }) {
    const [given, ...rest] = input.recipientName.split(" ");
    const draft = await this.call<{ id?: string; href?: string; detail?: { invoice_number?: string } }>(
      "POST",
      "/v2/invoicing/invoices",
      {
        detail: {
          currency_code: "USD",
          note: input.note.slice(0, 4000),
          terms_and_conditions: input.terms.slice(0, 4000),
          payment_term: { term_type: "NET_30" },
        },
        primary_recipients: [
          { billing_info: { email_address: input.recipientEmail, name: { given_name: given, surname: rest.join(" ") || given } } },
        ],
        items: input.lines.map((l) => ({
          name: l.description.slice(0, 200),
          quantity: String(l.quantity),
          unit_amount: { currency_code: "USD", value: money(l.unitPrice) },
          unit_of_measure: "QUANTITY",
        })),
      },
      `${input.requestId}-draft`,
    );
    const id = draft.id ?? draft.href?.split("/").pop();
    if (!id) throw new PayPalError("Invoice draft returned no id", 500);
    await this.call("POST", `/v2/invoicing/invoices/${id}/send`, { send_to_invoicer: false }, `${input.requestId}-send`);
    const inv = await this.call<{ status: string; detail?: { invoice_number?: string } }>("GET", `/v2/invoicing/invoices/${id}`);
    return { invoiceId: id, status: inv.status, invoiceNumber: inv.detail?.invoice_number };
  }

  async ensurePlan(input: { productName: string; planName: string; monthlyPrice: number }) {
    const key = `${input.planName}:${input.monthlyPrice}`;
    const fromEnv = process.env.PAYPAL_PLAN_ID;
    if (fromEnv) return fromEnv;
    const hit = planCache.get(key);
    if (hit) return hit;
    const product = await this.call<{ id: string }>("POST", "/v1/catalogs/products", { name: input.productName, type: "PHYSICAL" });
    const plan = await this.call<{ id: string }>("POST", "/v1/billing/plans", {
      product_id: product.id,
      name: input.planName,
      billing_cycles: [
        {
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          tenure_type: "REGULAR",
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: money(input.monthlyPrice), currency_code: "USD" } },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 },
    });
    planCache.set(key, plan.id);
    return plan.id;
  }

  async createActiveSubscription(input: { planId: string; customId: string; subscriberName: string; subscriberEmail: string; card: CardSource }) {
    const [given, ...rest] = input.subscriberName.split(" ");
    const sub = await this.call<{ id: string; status: string }>("POST", "/v1/billing/subscriptions", {
      plan_id: input.planId,
      custom_id: input.customId,
      subscriber: {
        name: { given_name: given, surname: rest.join(" ") || given },
        email_address: input.subscriberEmail,
        payment_source: { card: cardPayload(input.card) },
      },
    });
    return { subscriptionId: sub.id, status: sub.status };
  }

  async getSubscriptionFacts(subscriptionId: string): Promise<SubscriptionFacts> {
    const s = await this.call<{ id: string; status: string; custom_id?: string }>("GET", `/v1/billing/subscriptions/${subscriptionId}`);
    return { subscriptionId: s.id, status: s.status, customId: s.custom_id };
  }

  async suspendSubscription(input: { subscriptionId: string; reason: string; requestId: string }) {
    await this.call("POST", `/v1/billing/subscriptions/${input.subscriptionId}/suspend`, { reason: input.reason.slice(0, 128) }, input.requestId);
  }
}
