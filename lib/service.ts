// 앱 동작의 중심: 워크스페이스 시드, 메시지 분석→정책 판정→자동 실행 또는 서명 대기, 서명·거절·금액 수정·위임 한도 변경
import { randomUUID } from "node:crypto";
import { analyze } from "./agent";
import type { LlmClient } from "./agent/agent";
import { execute, gatherFacts } from "./executor";
import { getPayPal, paypalMode } from "./paypal";
import type { PayPalPort } from "./paypal/port";
import { evaluate } from "./policy";
import { provision, seedData } from "./seed";
import { loadWorkspace, saveWorkspace, withWorkspaceLock } from "./store";
import type { AuditEntry, InboxMessage, Mandate, Plan, PlanStatus, Workspace } from "./types";

export interface Deps {
  paypal?: PayPalPort;
  llm?: LlmClient;
}

const now = () => new Date().toISOString();
const shortId = () => randomUUID().replace(/-/g, "").slice(0, 10);

function audit(ws: Workspace, e: Omit<AuditEntry, "at">) {
  ws.audit.unshift({ at: now(), ...e });
  if (ws.audit.length > 300) ws.audit.length = 300;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function createWorkspace(id: string, deps: Deps): Promise<Workspace> {
  const paypal = deps.paypal ?? getPayPal();
  const ws = seedData(id, paypal.mode);
  audit(ws, { actor: "system", event: "Workspace created", detail: `Seeding ${ws.orders.length} orders and ${ws.subscriptions.length} subscription in PayPal ${paypal.mode}` });
  try {
    await provision(ws, paypal);
    audit(ws, {
      actor: "paypal",
      event: "Sandbox seeded",
      detail: `Captured orders ${ws.orders.map((o) => o.paypalOrderId).join(", ")}; subscription ${ws.subscriptions.map((s) => s.paypalSubscriptionId).join(", ")}`,
    });
  } catch (e) {
    ws.seedError = errorText(e);
    audit(ws, { actor: "paypal", event: "Seeding failed", detail: ws.seedError });
  }
  await saveWorkspace(ws);
  return ws;
}

export async function getWorkspace(id: string, deps: Deps = {}): Promise<Workspace> {
  return withWorkspaceLock(id, async () => (await loadWorkspace(id)) ?? createWorkspace(id, deps));
}

export async function resetWorkspace(id: string, deps: Deps = {}): Promise<Workspace> {
  return withWorkspaceLock(id, () => createWorkspace(id, deps));
}

function statusFor(verdict: Plan["policy"]["verdict"]): PlanStatus {
  return verdict === "blocked" ? "blocked" : verdict === "review" ? "needs_review" : "awaiting_signature";
}

async function runExecution(ws: Workspace, plan: Plan, paypal: PayPalPort, by: "mandate" | "seller") {
  plan.status = "executing";
  try {
    plan.execution = await execute(ws, plan, paypal, by);
    plan.status = "executed";
    plan.error = undefined;
    audit(ws, {
      actor: plan.execution.kind === "reply" ? "system" : "paypal",
      event: by === "mandate" ? "Executed under mandate" : "Executed after countersignature",
      detail: plan.execution.detail ?? "",
      planId: plan.id,
      paypalId: plan.execution.paypalId,
    });
  } catch (e) {
    plan.status = "failed";
    plan.error = errorText(e);
    audit(ws, { actor: "paypal", event: "Execution failed", detail: plan.error, planId: plan.id });
  }
}

/** Analyze one inbox message into a plan, judge it, and auto-execute it if the mandate allows. */
export async function triageMessage(wsId: string, messageId: string, opts: { allowLive: boolean } & Deps): Promise<Workspace> {
  return withWorkspaceLock(wsId, async () => {
    const ws = await loadWorkspace(wsId);
    if (!ws) throw new Error("Workspace not found");
    const message = ws.messages.find((m) => m.id === messageId);
    if (!message) throw new Error("Message not found");
    if (ws.plans.some((p) => p.messageId === messageId)) return ws;
    const paypal = opts.paypal ?? getPayPal(ws.paypalMode);

    const run = await analyze(ws, message, paypal, { allowLive: opts.allowLive, llm: opts.llm });
    const facts = await gatherFacts(ws, run.proposal, paypal);
    const policy = evaluate(ws, message, run.proposal, null, facts);
    const plan: Plan = {
      id: `pl-${shortId()}`,
      messageId,
      customerKey: message.customerKey,
      proposal: run.proposal,
      amountOverride: null,
      policy,
      status: statusFor(policy.verdict),
      aiSource: run.source,
      model: run.model,
      trace: run.trace,
      createdAt: now(),
    };
    ws.plans.unshift(plan);
    audit(ws, {
      actor: "agent",
      event: "Proposed",
      detail: `${plan.proposal.summary} (${run.source === "live" ? `${run.model}, ${run.usage.input}+${run.usage.output} tokens` : run.source === "cached" ? `recorded ${run.model} run` : "rules"})`,
      planId: plan.id,
    });
    audit(ws, { actor: "policy", event: `Verdict: ${policy.verdict}`, detail: policy.headline, planId: plan.id });
    if (policy.verdict === "auto") await runExecution(ws, plan, paypal, "mandate");
    await saveWorkspace(ws);
    return ws;
  });
}

export async function triageInbox(wsId: string, opts: { allowLive: boolean } & Deps): Promise<Workspace> {
  let ws = await getWorkspace(wsId, opts);
  for (const m of [...ws.messages].reverse()) {
    if (!ws.plans.some((p) => p.messageId === m.id)) ws = await triageMessage(wsId, m.id, opts);
  }
  return ws;
}

async function mutatePlan(wsId: string, planId: string, fn: (ws: Workspace, plan: Plan, message: InboxMessage) => Promise<void>): Promise<Workspace> {
  return withWorkspaceLock(wsId, async () => {
    const ws = await loadWorkspace(wsId);
    if (!ws) throw new Error("Workspace not found");
    const plan = ws.plans.find((p) => p.id === planId);
    if (!plan) throw new Error("Plan not found");
    const message = ws.messages.find((m) => m.id === plan.messageId)!;
    await fn(ws, plan, message);
    await saveWorkspace(ws);
    return ws;
  });
}

const OPEN: PlanStatus[] = ["awaiting_signature", "needs_review", "blocked", "failed"];

export async function editAmount(wsId: string, planId: string, amount: number, deps: Deps = {}): Promise<Workspace> {
  return mutatePlan(wsId, planId, async (ws, plan, message) => {
    if (!OPEN.includes(plan.status)) throw new Error(`Plan is ${plan.status}`);
    if (plan.proposal.action !== "refund") throw new Error("Only refund amounts can be edited");
    if (!Number.isFinite(amount)) throw new Error("Amount must be a number");
    const paypal = deps.paypal ?? getPayPal(ws.paypalMode);
    plan.amountOverride = Math.round(amount * 100) / 100;
    plan.policy = evaluate(ws, message, plan.proposal, plan.amountOverride, await gatherFacts(ws, plan.proposal, paypal));
    plan.status = statusFor(plan.policy.verdict);
    audit(ws, { actor: "seller", event: "Edited amount", detail: `Refund set to $${plan.amountOverride.toFixed(2)} - ${plan.policy.headline}`, planId });
  });
}

/** The countersignature: re-check policy against fresh PayPal facts, then execute. */
export async function signPlan(wsId: string, planId: string, opts: { override?: boolean } & Deps = {}): Promise<Workspace> {
  return mutatePlan(wsId, planId, async (ws, plan, message) => {
    if (!OPEN.includes(plan.status)) throw new Error(`Plan is ${plan.status}`);
    if (plan.proposal.action === "escalate") throw new Error("Escalated items have no PayPal action to sign");
    const paypal = opts.paypal ?? getPayPal(ws.paypalMode);
    plan.policy = evaluate(ws, message, plan.proposal, plan.amountOverride, await gatherFacts(ws, plan.proposal, paypal));
    if (plan.policy.verdict === "blocked") {
      plan.status = "blocked";
      audit(ws, { actor: "policy", event: "Signature refused", detail: plan.policy.headline, planId });
      return;
    }
    if (plan.policy.verdict === "review" && !opts.override) throw new Error("This item needs review; confirm the override to sign it");
    audit(ws, { actor: "seller", event: plan.policy.verdict === "review" ? "Countersigned (override)" : "Countersigned", detail: plan.proposal.summary + (plan.policy.amount !== null ? ` - $${plan.policy.amount.toFixed(2)}` : ""), planId });
    await runExecution(ws, plan, paypal, "seller");
  });
}

export async function rejectPlan(wsId: string, planId: string): Promise<Workspace> {
  return mutatePlan(wsId, planId, async (ws, plan) => {
    if (!OPEN.includes(plan.status)) throw new Error(`Plan is ${plan.status}`);
    plan.status = "rejected";
    audit(ws, { actor: "seller", event: "Rejected", detail: plan.proposal.summary, planId });
  });
}

export async function updateMandate(wsId: string, patch: Partial<Mandate>): Promise<Workspace> {
  return withWorkspaceLock(wsId, async () => {
    const ws = await loadWorkspace(wsId);
    if (!ws) throw new Error("Workspace not found");
    const m = ws.mandate;
    if (patch.autoRefundMaxUsd !== undefined) m.autoRefundMaxUsd = clamp(patch.autoRefundMaxUsd, 0, 500);
    if (patch.autoRefundMaxPct !== undefined) m.autoRefundMaxPct = clamp(patch.autoRefundMaxPct, 0, 100);
    if (patch.autoSuspendSubscriptions !== undefined) m.autoSuspendSubscriptions = !!patch.autoSuspendSubscriptions;
    if (patch.autoReplyOnly !== undefined) m.autoReplyOnly = !!patch.autoReplyOnly;
    audit(ws, {
      actor: "seller",
      event: "Mandate updated",
      detail: `Auto-refund up to $${m.autoRefundMaxUsd} and ${m.autoRefundMaxPct}%; pauses ${m.autoSuspendSubscriptions ? "auto" : "signed"}; replies ${m.autoReplyOnly ? "auto" : "signed"}`,
    });
    await saveWorkspace(ws);
    return ws;
  });
}

function clamp(n: number, lo: number, hi: number) {
  if (!Number.isFinite(n)) throw new Error("Mandate values must be numbers");
  return Math.min(hi, Math.max(lo, Math.round(n * 100) / 100));
}

export async function addMessage(wsId: string, input: { customerKey: string; subject: string; body: string }): Promise<{ ws: Workspace; messageId: string }> {
  return withWorkspaceLock(wsId, async () => {
    const ws = await loadWorkspace(wsId);
    if (!ws) throw new Error("Workspace not found");
    if (!ws.customers.some((c) => c.key === input.customerKey)) throw new Error("Unknown customer");
    const body = input.body.trim().slice(0, 1500);
    if (body.length < 5) throw new Error("Message is too short");
    const message: InboxMessage = {
      id: `msg-${shortId()}`,
      customerKey: input.customerKey,
      subject: input.subject.trim().slice(0, 120) || "(no subject)",
      body,
      receivedAt: now(),
    };
    ws.messages.unshift(message);
    if (ws.messages.length > 40) ws.messages.length = 40;
    audit(ws, { actor: "system", event: "Message received", detail: `${message.subject} (written in the demo)` });
    await saveWorkspace(ws);
    return { ws, messageId: message.id };
  });
}

export { paypalMode };
