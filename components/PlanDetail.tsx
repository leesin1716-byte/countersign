"use client";
// 선택한 변경안 상세: 근거·정책 검사·에이전트 도구 호출·답장 초안·PayPal 실행 결과와 서명/거절 버튼
import { useEffect, useState } from "react";
import type { Plan, Workspace } from "@/lib/types";
import { ACTION_LABEL, INTENT_LABEL, VERDICT_LABEL, customerName, statusLabel, statusTone, time, usd } from "./format";

interface Props {
  ws: Workspace;
  plan: Plan | null;
  busy: string | null;
  onSign: (id: string, override: boolean) => void;
  onReject: (id: string) => void;
  onAmount: (id: string, amount: number) => void;
}

const SOURCE_LABEL = { message: "Customer", paypal: "PayPal", carrier: "Carrier", attachment: "Photo" } as const;
const OPEN = ["awaiting_signature", "needs_review", "blocked", "failed"];

export default function PlanDetail({ ws, plan, busy, onSign, onReject, onAmount }: Props) {
  const [amount, setAmount] = useState("");
  const [showTrace, setShowTrace] = useState(false);
  useEffect(() => {
    setAmount(plan?.policy.amount != null ? plan.policy.amount.toFixed(2) : "");
  }, [plan?.id, plan?.policy.amount]);

  if (!plan) {
    return (
      <div className="detail detail-empty">
        <p>Select a row to see what the agent read, what policy checked, and what PayPal will do.</p>
      </div>
    );
  }
  const message = ws.messages.find((m) => m.id === plan.messageId)!;
  const p = plan.proposal;
  const working = busy === `plan:${plan.id}`;
  const open = OPEN.includes(plan.status);
  const canSign = open && p.action !== "escalate" && plan.policy.verdict !== "blocked";
  const review = plan.policy.verdict === "review";

  return (
    <article className="detail" data-testid="plan-detail">
      <header className="detail-head">
        <div>
          <p className="eyebrow">
            {INTENT_LABEL[p.intent]} · {customerName(ws, plan.customerKey)} · {message.subject}
          </p>
          <h3>
            {ACTION_LABEL[p.action]}
            {plan.policy.amount != null && <span className="amt">{usd(plan.policy.amount)}</span>}
          </h3>
          <p className="detail-summary">{p.summary}</p>
        </div>
        <div className="detail-badges">
          {VERDICT_LABEL[plan.policy.verdict] !== statusLabel(plan) && (
            <span className={`chip chip-${{ auto: "ok", signature: "wait", review: "warn", blocked: "bad" }[plan.policy.verdict]}`}>{VERDICT_LABEL[plan.policy.verdict]}</span>
          )}
          <span className={`chip chip-${statusTone(plan.status)}`} data-testid="plan-status">
            {statusLabel(plan)}
          </span>
        </div>
      </header>

      <div className="detail-cols">
        <section>
          <h4>What the agent relied on</h4>
          {message.attachment && (
            <figure className="attach">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={message.attachment.path} alt={message.attachment.alt} width={160} height={120} />
              <figcaption>Customer photo (illustration). Sent to the model as an image.</figcaption>
            </figure>
          )}
          <ul className="evidence">
            {p.evidence.map((e, i) => (
              <li key={i}>
                <span className={`src src-${e.source}`}>{SOURCE_LABEL[e.source]}</span>
                <span>{e.text}</span>
              </li>
            ))}
          </ul>
          {p.riskFlags.length > 0 && (
            <p className="flags">
              Flags: {p.riskFlags.map((f) => <code key={f}>{f}</code>)}
            </p>
          )}
          <p className="model-note">
            {plan.aiSource === "live" && <>Drafted live by {plan.model}.</>}
            {plan.aiSource === "cached" && <>Recorded {plan.model} run for this scripted message; tool lookups were replayed against your PayPal sandbox objects just now.</>}
            {plan.aiSource === "mock" && <>Drafted by the rules fallback (live AI off).</>}
            {plan.trace.length > 0 && (
              <button className="linkish" onClick={() => setShowTrace((s) => !s)}>
                {showTrace ? "Hide" : "Show"} {plan.trace.length} tool call{plan.trace.length > 1 ? "s" : ""}
              </button>
            )}
          </p>
          {showTrace && (
            <ol className="trace">
              {plan.trace.map((t, i) => (
                <li key={i}>
                  <code>
                    {t.tool}({Object.keys(t.input).length ? JSON.stringify(t.input) : ""})
                  </code>
                  <pre>{prettyOutput(t.output)}</pre>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section>
          <h4>Policy checks <span className="muted">re-run against PayPal at signing</span></h4>
          <ul className="checks" data-testid="checks">
            {plan.policy.checks.map((c, i) => (
              <li key={i} className={c.pass ? "pass" : "fail"}>
                <span className="tick" aria-hidden>{c.pass ? "✓" : "✕"}</span>
                <div>
                  <b>{c.rule}</b>
                  <span>{c.detail}</span>
                </div>
              </li>
            ))}
          </ul>
          {p.action === "invoice" && p.invoiceLines && (
            <table className="lines">
              <tbody>
                {p.invoiceLines.map((l, i) => (
                  <tr key={i}>
                    <td>{l.quantity} ×</td>
                    <td>{l.description}</td>
                    <td>{usd(l.unitPrice)}</td>
                    <td>{usd(l.quantity * l.unitPrice)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>{p.invoiceTerms}</td>
                  <td>{usd(plan.policy.amount)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </section>

        <section>
          <h4>Reply draft</h4>
          <blockquote className="reply">{p.replyDraft}</blockquote>
          {p.action === "escalate" && open && <p className="hint">Nothing will move in PayPal. Handle it yourself or reject it.</p>}
          {plan.execution && (
            <div className="receipt" data-testid="receipt">
              <p className="receipt-title">
                {plan.execution.by === "mandate" ? "Executed under your mandate" : "Countersigned and executed"} · {time(plan.execution.at)}
              </p>
              {plan.execution.paypalId && (
                <p className="mono">
                  {plan.execution.kind === "refund" ? "Refund" : plan.execution.kind === "invoice" ? "Invoice" : "Subscription"} {plan.execution.paypalId}
                  {plan.execution.paypalStatus && <> · {plan.execution.paypalStatus}</>}
                </p>
              )}
              <p>{plan.execution.detail}</p>
              {plan.execution.by === "seller" && <p className="sig">Hollow Pine</p>}
            </div>
          )}
          {plan.error && <p className="banner banner-bad">{plan.error}</p>}
        </section>
      </div>

      {open && (
        <footer className="detail-actions">
          {p.action === "refund" && (
            <form
              className="amount-edit"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(amount);
                if (Number.isFinite(n)) onAmount(plan.id, n);
              }}
            >
              <label htmlFor="amt">Refund $</label>
              <input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="amount-input" />
              <button className="btn btn-small" disabled={working}>
                Re-check
              </button>
            </form>
          )}
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={() => onReject(plan.id)} disabled={working} data-testid="reject">
            Reject
          </button>
          {canSign && (
            <button
              className={`btn ${review ? "btn-warn" : "btn-sign"}`}
              disabled={working}
              data-testid="sign"
              onClick={() => {
                if (review && !window.confirm("Policy asked for a human review. Sign and execute anyway?")) return;
                onSign(plan.id, review);
              }}
            >
              {working ? "Executing in PayPal…" : review ? "Override and countersign" : `Countersign · ${signVerb(plan)}`}
            </button>
          )}
        </footer>
      )}
    </article>
  );
}

function signVerb(plan: Plan): string {
  switch (plan.proposal.action) {
    case "refund":
      return `refund ${usd(plan.policy.amount)}`;
    case "invoice":
      return `send ${usd(plan.policy.amount)} invoice`;
    case "suspend_subscription":
      return "pause subscription";
    default:
      return "mark replied";
  }
}

function prettyOutput(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 1).slice(0, 900);
  } catch {
    return s.slice(0, 900);
  }
}
