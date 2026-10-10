// Claude Haiku 도구 호출 루프: 고객 메시지를 읽고 읽기 전용 PayPal 조회로 사실을 모아 변경안(Proposal)을 만든다
import { readFile } from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { SYSTEM_PROMPT, TOOLS } from "./prompt";
import type { PayPalPort } from "../paypal/port";
import type { AgentStep, InboxMessage, Proposal, Workspace } from "../types";

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const MAX_TURNS = 6;

/** The slice of the Anthropic client the agent needs; tests inject a scripted fake. */
export interface LlmClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

const ProposalInput = z.object({
  intent: z.enum(["late_delivery", "damaged_item", "wholesale_quote", "pause_subscription", "where_is_my_order", "refund_request", "other"]),
  action: z.enum(["refund", "invoice", "suspend_subscription", "reply_only", "escalate"]),
  order_ref: z.string().nullish(),
  subscription_ref: z.string().nullish(),
  refund_amount_usd: z.number().nonnegative().nullish(),
  invoice_lines: z
    .array(z.object({ sku: z.string(), description: z.string(), quantity: z.number().int().positive(), unit_price_usd: z.number().nonnegative() }))
    .nullish(),
  invoice_terms: z.string().nullish(),
  summary: z.string().min(1),
  evidence: z.array(z.object({ source: z.enum(["message", "paypal", "carrier", "attachment"]), text: z.string() })),
  reply_draft: z.string(),
  risk_flags: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export function toProposal(input: unknown): Proposal {
  const p = ProposalInput.parse(input);
  return {
    intent: p.intent,
    action: p.action,
    orderRef: p.order_ref ?? null,
    subscriptionRef: p.subscription_ref ?? null,
    refundAmount: p.refund_amount_usd ?? null,
    invoiceLines: p.invoice_lines?.map((l) => ({ sku: l.sku, description: l.description, quantity: l.quantity, unitPrice: l.unit_price_usd })) ?? null,
    invoiceTerms: p.invoice_terms ?? null,
    summary: p.summary.slice(0, 120),
    evidence: p.evidence.slice(0, 8),
    replyDraft: p.reply_draft,
    riskFlags: p.risk_flags,
    confidence: p.confidence,
  };
}

/** Read-only tools. Each call is scoped to the message sender, so the model cannot look at other customers. */
export async function runTool(ws: Workspace, message: InboxMessage, paypal: PayPalPort, name: string, input: Record<string, unknown>): Promise<string> {
  const mine = (key: string) => key === message.customerKey;
  switch (name) {
    case "list_customer_records": {
      const orders = ws.orders.filter((o) => mine(o.customerKey)).map((o) => ({ ref: o.ref, items: o.items.map((i) => `${i.quantity} x ${i.description}`), total_usd: o.total, placed: o.placedAt.slice(0, 10) }));
      const subs = ws.subscriptions.filter((s) => mine(s.customerKey)).map((s) => ({ ref: s.ref, plan: s.planName, monthly_usd: s.monthlyPrice }));
      return JSON.stringify({ orders, subscriptions: subs });
    }
    case "get_order": {
      const order = ws.orders.find((o) => o.ref === String(input.order_ref ?? "").trim().toUpperCase() && mine(o.customerKey));
      if (!order || !order.paypalOrderId) return JSON.stringify({ error: `No order ${input.order_ref} on file for this customer.` });
      const f = await paypal.getOrderFacts(order.paypalOrderId);
      return JSON.stringify({
        ref: order.ref,
        items: order.items,
        paypal: { order_id: f.orderId, status: f.status, captured_usd: f.captured, refunded_usd: f.refunded, refundable_usd: Math.round((f.captured - f.refunded) * 100) / 100, trackers: f.trackers },
        carrier: order.shipment
          ? {
              carrier: order.shipment.carrier,
              tracking_number: order.shipment.trackingNumber,
              status: order.shipment.status,
              promised_by: order.shipment.promisedBy,
              delivered_at: order.shipment.deliveredAt ?? null,
              scans: order.shipment.scans,
            }
          : null,
      });
    }
    case "get_subscription": {
      const sub = ws.subscriptions.find((s) => s.ref === String(input.subscription_ref ?? "").trim().toUpperCase() && mine(s.customerKey));
      if (!sub || !sub.paypalSubscriptionId) return JSON.stringify({ error: `No subscription ${input.subscription_ref} on file for this customer.` });
      const f = await paypal.getSubscriptionFacts(sub.paypalSubscriptionId);
      return JSON.stringify({ ref: sub.ref, plan: sub.planName, monthly_usd: sub.monthlyPrice, paypal: { subscription_id: f.subscriptionId, status: f.status } });
    }
    case "get_price_list":
      return JSON.stringify(ws.catalog);
    default:
      return JSON.stringify({ error: `Unknown tool ${name}` });
  }
}

async function userContent(ws: Workspace, message: InboxMessage): Promise<Anthropic.ContentBlockParam[]> {
  const customer = ws.customers.find((c) => c.key === message.customerKey)!;
  const blocks: Anthropic.ContentBlockParam[] = [];
  if (message.attachment) {
    const file = path.join(process.cwd(), "public", message.attachment.path);
    const data = (await readFile(file)).toString("base64");
    blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data } });
  }
  blocks.push({
    type: "text",
    text: [
      `Sender: ${customer.name} <${customer.email}>`,
      `Received: ${message.receivedAt}`,
      `Today: ${new Date().toISOString().slice(0, 10)}`,
      message.attachment ? "The customer attached the photo above." : "No attachment.",
      "",
      "<customer_message>",
      `Subject: ${message.subject}`,
      message.body,
      "</customer_message>",
    ].join("\n"),
  });
  return blocks;
}

export interface AgentRun {
  proposal: Proposal;
  trace: AgentStep[];
  model: string;
  usage: { input: number; output: number };
}

export async function runAgent(opts: { ws: Workspace; message: InboxMessage; paypal: PayPalPort; llm: LlmClient; model?: string }): Promise<AgentRun> {
  const { ws, message, paypal, llm } = opts;
  const model = opts.model ?? DEFAULT_MODEL;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: await userContent(ws, message) }];
  const trace: AgentStep[] = [];
  const usage = { input: 0, output: 0 };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const last = turn === MAX_TURNS - 1;
    const res = await llm.create({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      // Every turn must be a tool call; the final turn must be the proposal.
      tool_choice: last ? { type: "tool", name: "submit_proposal" } : { type: "any" },
      messages,
    });
    usage.input += res.usage.input_tokens;
    usage.output += res.usage.output_tokens;
    if (res.stop_reason === "max_tokens") throw new Error("Agent response was cut off (max_tokens)");

    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (calls.length === 0) throw new Error("Agent returned no tool call");
    messages.push({ role: "assistant", content: res.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    let proposal: Proposal | null = null;
    for (const call of calls) {
      const input = (call.input ?? {}) as Record<string, unknown>;
      if (call.name === "submit_proposal") {
        try {
          proposal = toProposal(input);
          trace.push({ tool: call.name, input: {}, output: "accepted" });
          results.push({ type: "tool_result", tool_use_id: call.id, content: "Proposal received." });
        } catch (e) {
          const msg = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String(e);
          trace.push({ tool: call.name, input: {}, output: `rejected: ${msg}` });
          results.push({ type: "tool_result", tool_use_id: call.id, content: `Invalid proposal: ${msg}. Fix and call submit_proposal again.`, is_error: true });
        }
        continue;
      }
      let output: string;
      let isError = false;
      try {
        output = await runTool(ws, message, paypal, call.name, input);
      } catch (e) {
        output = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
        isError = true;
      }
      trace.push({ tool: call.name, input, output });
      results.push({ type: "tool_result", tool_use_id: call.id, content: output, ...(isError ? { is_error: true } : {}) });
    }
    if (proposal) return { proposal, trace, model, usage };
    messages.push({ role: "user", content: results });
  }
  throw new Error("Agent did not submit a valid proposal");
}
