// PayPal 샌드박스에서 앱이 쓰는 API(주문·환불·배송추적·인보이스·구독)가 실제로 되는지 한 번씩 확인하는 실측 스크립트
// Usage: node scripts/sandbox-probe.mjs   (reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from .env.local; never prints them)
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const BASE = "https://api-m.sandbox.paypal.com";

async function token() {
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const j = await r.json();
  return j;
}

let T;
async function pp(method, path, body, extraHeaders = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${T}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      "PayPal-Request-Id": crypto.randomUUID(),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

function brief(label, res, pick) {
  const ok = res.status >= 200 && res.status < 300;
  const detail = ok ? pick?.(res.json) : (res.json?.details?.[0]?.issue || res.json?.name || res.json?.message || String(res.json).slice(0, 200));
  console.log(`${ok ? "OK  " : "FAIL"} ${res.status} ${label} ${detail ? JSON.stringify(detail) : ""}`);
  return ok;
}

const tk = await token();
T = tk.access_token;
console.log("token:", T ? "OK" : "FAIL", "app_id:", tk.app_id ? "present" : "-");
const scopes = (tk.scope || "").split(" ");
const interesting = ["invoicing", "subscriptions", "vault", "tracking", "disputes", "payouts", "billing", "checkout"];
console.log("scope hits:", scopes.filter((s) => interesting.some((k) => s.toLowerCase().includes(k))).map((s) => s.replace("https://uri.paypal.com/services/", "")).join(" | "));

// 1. Order with card payment_source (direct capture without buyer approval)
const order = await pp("POST", "/v2/checkout/orders", {
  intent: "CAPTURE",
  purchase_units: [{ reference_id: "probe-1", amount: { currency_code: "USD", value: "48.00" }, description: "Probe order" }],
  payment_source: {
    card: {
      number: "4032039317984658",
      expiry: "2030-12",
      security_code: "123",
      name: "Probe Buyer",
      billing_address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" },
    },
  },
});
brief("order+card", order, (j) => ({ id: j.id, status: j.status, cap: j.purchase_units?.[0]?.payments?.captures?.[0]?.status }));
const orderId = order.json?.id;
const capture = order.json?.purchase_units?.[0]?.payments?.captures?.[0];

if (capture?.id) {
  // 2. Partial refund
  const ref = await pp("POST", `/v2/payments/captures/${capture.id}/refund`, { amount: { currency_code: "USD", value: "4.80" }, note_to_payer: "Probe partial refund" });
  brief("refund partial", ref, (j) => ({ id: j.id, status: j.status }));
  // 3. Tracking
  const tr = await pp("POST", `/v2/checkout/orders/${orderId}/track`, { capture_id: capture.id, tracking_number: "PROBE123456789", carrier: "USPS", notify_payer: false });
  brief("track add", tr, (j) => ({ trackers: j.purchase_units?.[0]?.shipping?.trackers?.map((t) => t.id) }));
  const get = await pp("GET", `/v2/checkout/orders/${orderId}`);
  brief("order get", get, (j) => ({ status: j.status, trackers: j.purchase_units?.[0]?.shipping?.trackers?.length, refunds: j.purchase_units?.[0]?.payments?.refunds?.length }));
  // full refund of remainder
  const ref2 = await pp("POST", `/v2/payments/captures/${capture.id}/refund`, {});
  brief("refund remainder", ref2, (j) => ({ id: j.id, status: j.status, amt: j.amount?.value }));
}

// 4. Invoicing
const inv = await pp("POST", "/v2/invoicing/invoices", {
  detail: { currency_code: "USD", note: "Probe", payment_term: { term_type: "NET_30" } },
  primary_recipients: [{ billing_info: { email_address: "probe-buyer@example.com", name: { given_name: "Probe", surname: "Buyer" } } }],
  items: [{ name: "Probe item", quantity: "10", unit_amount: { currency_code: "USD", value: "12.00" } }],
});
const invId = inv.json?.id || inv.json?.href?.split("/").pop();
brief("invoice create", inv, () => ({ id: invId }));
if (invId) {
  const send = await pp("POST", `/v2/invoicing/invoices/${invId}/send`, { send_to_invoicer: false });
  brief("invoice send", send, (j) => j?.href ? "sent" : j);
  const rem = await pp("POST", `/v2/invoicing/invoices/${invId}/remind`, { subject: "Reminder", note: "Probe reminder" });
  brief("invoice remind", rem, () => "reminded");
  const can = await pp("POST", `/v2/invoicing/invoices/${invId}/cancel`, { send_to_recipient: false });
  brief("invoice cancel", can, () => "cancelled");
}

// 5. Subscriptions
const prod = await pp("POST", "/v1/catalogs/products", { name: "Probe Box", type: "SERVICE" });
brief("product create", prod, (j) => ({ id: j.id }));
if (prod.json?.id) {
  const plan = await pp("POST", "/v1/billing/plans", {
    product_id: prod.json.id,
    name: "Probe monthly",
    billing_cycles: [{ frequency: { interval_unit: "MONTH", interval_count: 1 }, tenure_type: "REGULAR", sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: { value: "24.00", currency_code: "USD" } } }],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 },
  });
  brief("plan create", plan, (j) => ({ id: j.id, status: j.status }));
  if (plan.json?.id) {
    const sub = await pp("POST", "/v1/billing/subscriptions", {
      plan_id: plan.json.id,
      subscriber: { name: { given_name: "Probe", surname: "Buyer" }, email_address: "probe-buyer@example.com" },
      application_context: { return_url: "https://example.com/ok", cancel_url: "https://example.com/cancel" },
    });
    brief("subscription create", sub, (j) => ({ id: j.id, status: j.status }));
    const subCard = await pp("POST", "/v1/billing/subscriptions", {
      plan_id: plan.json.id,
      subscriber: {
        name: { given_name: "Probe", surname: "Buyer" },
        email_address: "probe-buyer@example.com",
        payment_source: { card: { number: "4032039317984658", expiry: "2030-12", security_code: "123", name: "Probe Buyer", billing_address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" } } },
      },
    });
    brief("subscription create with card (needs card processing)", subCard, (j) => ({ id: j.id, status: j.status }));
    if (sub.json?.id) {
      const sus = await pp("POST", `/v1/billing/subscriptions/${sub.json.id}/suspend`, { reason: "Probe" });
      brief("subscription suspend (expected to need ACTIVE)", sus);
    }
  }
}

// 6. Disputes list (read only)
const dis = await pp("GET", "/v1/customer/disputes?page_size=1");
brief("disputes list", dis, (j) => ({ n: j.items?.length ?? 0 }));
