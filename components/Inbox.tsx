"use client";
// 받은편지함: 고객 메시지 목록·처리 상태, 메시지별 에이전트 실행, 데모용 새 메시지 작성
import { useState } from "react";
import type { Workspace } from "@/lib/types";
import { ago, customerName, statusLabel, statusTone } from "./format";

interface Props {
  ws: Workspace;
  busy: string | null;
  selectedPlanId: string | null;
  liveAi: boolean;
  onSelectPlan: (id: string) => void;
  onTriage: (messageId: string) => void;
  onCompose: (input: { customerKey: string; subject: string; body: string }) => Promise<boolean>;
}

export default function Inbox({ ws, busy, selectedPlanId, liveAi, onSelectPlan, onTriage, onCompose }: Props) {
  const [open, setOpen] = useState(false);
  const [customerKey, setCustomerKey] = useState(ws.customers[0].key);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  return (
    <aside className="inbox" aria-label="Inbox">
      <div className="panel-head">
        <h2>Inbox</h2>
        <button className="btn btn-small" onClick={() => setOpen((o) => !o)} data-testid="compose-toggle">
          {open ? "Close" : "Write as a customer"}
        </button>
      </div>

      {open && (
        <form
          className="compose"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await onCompose({ customerKey, subject, body })) {
              setSubject("");
              setBody("");
              setOpen(false);
            }
          }}
        >
          <label>
            From
            <select value={customerKey} onChange={(e) => setCustomerKey(e.target.value)} data-testid="compose-from">
              {ws.customers.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                  {ws.orders.filter((o) => o.customerKey === c.key).map((o) => ` · ${o.ref}`).join("")}
                  {ws.subscriptions.filter((s) => s.customerKey === c.key).map((s) => ` · ${s.ref}`).join("")}
                </option>
              ))}
            </select>
          </label>
          <label>
            Subject
            <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} placeholder="e.g. Chipped mug" />
          </label>
          <label>
            Message
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              maxLength={1500}
              required
              minLength={5}
              placeholder="Try a partial refund request, a pause, or an attempt to trick the agent."
              data-testid="compose-body"
            />
          </label>
          <p className="hint">{liveAi ? "Runs a live Claude Haiku 4.5 call (a few per visitor per day)." : "Live AI is off here; the rules fallback will answer."}</p>
          <button className="btn btn-primary" disabled={!!busy} data-testid="compose-send">
            {busy === "compose" ? "Agent is reading…" : "Send to inbox"}
          </button>
        </form>
      )}

      <ul className="messages">
        {ws.messages.map((m) => {
          const plan = ws.plans.find((p) => p.messageId === m.id);
          const active = plan && plan.id === selectedPlanId;
          return (
            <li key={m.id} className={`msg ${active ? "msg-active" : ""}`} data-testid={`msg-${m.seedKey ?? m.id}`}>
              <button className="msg-hit" onClick={() => (plan ? onSelectPlan(plan.id) : onTriage(m.id))} disabled={!plan && !!busy}>
                <div className="msg-top">
                  <span className="msg-from">{customerName(ws, m.customerKey)}</span>
                  <span className="msg-time">{ago(m.receivedAt, Math.max(Date.parse(ws.clock), Date.parse(m.receivedAt)))}</span>
                </div>
                <div className="msg-subject">
                  {m.attachment && <span className="clip" title="Photo attached" aria-label="Photo attached">▣</span>}
                  {m.subject}
                </div>
                <p className="msg-body">{m.body}</p>
                <div className="msg-foot">
                  {plan ? (
                    <span className={`chip chip-${statusTone(plan.status)}`}>{statusLabel(plan)}</span>
                  ) : busy === `triage:${m.id}` ? (
                    <span className="chip chip-wait">Agent is reading…</span>
                  ) : (
                    <span className="chip chip-mute">Not triaged · click to run agent</span>
                  )}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
