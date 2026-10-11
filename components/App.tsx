"use client";
// 앱 셸: 워크스페이스를 불러오고 받은편지함·변경안 그리드·상세·감사 로그·위임 한도를 한 화면에 배치한다
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Mandate, Workspace } from "@/lib/types";
import AuditLog from "./AuditLog";
import Inbox from "./Inbox";
import MandateBar from "./MandateBar";
import PlanDetail from "./PlanDetail";
import PlanGrid from "./PlanGrid";

interface Meta {
  paypalMode: "sandbox" | "mock";
  liveAi: boolean;
  limits: { aiPerVisitorDaily: number };
}

type Busy = null | "load" | "triage" | "reset" | string;

export default function App() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>("load");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const call = useCallback(async (key: Busy, url: string, init?: RequestInit) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
      setWs(json.workspace);
      setMeta(json.meta);
      if (json.notice) setNotice(json.notice);
      return json as { workspace: Workspace; messageId?: string };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  // Load once: a second cookie-less request (React dev double-effect) would seed a second workspace and race the cookie.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void call("load", "/api/workspace");
  }, [call]);

  const post = (key: Busy, url: string, body: unknown) => call(key, url, { method: "POST", body: JSON.stringify(body) });

  const plan = useMemo(() => ws?.plans.find((p) => p.id === selected) ?? null, [ws, selected]);
  const counts = useMemo(() => {
    const plans = ws?.plans ?? [];
    return {
      waiting: plans.filter((p) => p.status === "awaiting_signature" || p.status === "needs_review").length,
      auto: plans.filter((p) => p.status === "executed" && p.execution?.by === "mandate").length,
      untriaged: (ws?.messages ?? []).filter((m) => !plans.some((p) => p.messageId === m.id)).length,
    };
  }, [ws]);

  const triageAll = async () => {
    const r = await post("triage", "/api/triage", {});
    const first = r?.workspace.plans.find((p) => p.status === "awaiting_signature" || p.status === "needs_review");
    if (first) setSelected(first.id);
  };

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden>
            <svg viewBox="0 0 32 32" width="28" height="28">
              <path d="M4 22c4-1 6-9 9-9s1 8 4 8 4-6 7-6 3 3 4 3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              <path d="M4 27h24" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".5" />
            </svg>
          </span>
          <div>
            <h1>Countersign</h1>
            <p className="sub">{ws?.store.name ?? "Loading store"} · back office</p>
          </div>
        </div>
        <div className="top-status">
          <span className={`pill ${meta?.paypalMode === "sandbox" ? "pill-live" : "pill-mock"}`} data-testid="paypal-mode">
            <i /> {meta?.paypalMode === "sandbox" ? "PayPal Sandbox · live API" : "PayPal simulated (no keys)"}
          </span>
          <span className={`pill ${meta?.liveAi ? "pill-live" : "pill-mock"}`}>
            <i /> {meta?.liveAi ? "Claude Haiku 4.5" : "AI rules fallback"}
          </span>
        </div>
        <div className="top-actions">
          <button className="btn btn-primary" onClick={triageAll} disabled={!!busy || !ws || counts.untriaged === 0} data-testid="run-agent">
            {busy === "triage" ? "Agent is reading…" : counts.untriaged ? `Run agent on ${counts.untriaged} message${counts.untriaged > 1 ? "s" : ""}` : "Inbox triaged"}
          </button>
          <button
            className="btn btn-ghost"
            onClick={async () => {
              setSelected(null);
              await post("reset", "/api/workspace/reset", {});
            }}
            disabled={!!busy}
            data-testid="reset"
          >
            {busy === "reset" ? "Seeding PayPal…" : "Reset demo"}
          </button>
        </div>
      </header>

      <section className="story">
        <ol>
          <li><b>Read.</b> Claude reads each customer message, looks up the order or subscription in PayPal, and drafts one change.</li>
          <li><b>Check.</b> A deterministic policy engine re-reads PayPal and checks ownership, refundable balance, the price list and your mandate.</li>
          <li><b>Countersign.</b> Small changes inside your mandate run on their own. Everything else waits for your signature, then executes in PayPal.</li>
        </ol>
      </section>

      {ws && <MandateBar mandate={ws.mandate} busy={!!busy} onSave={(m: Partial<Mandate>) => call("mandate", "/api/mandate", { method: "PUT", body: JSON.stringify(m) })} />}

      {(error || ws?.seedError || notice) && (
        <div className="banners">
          {ws?.seedError && (
            <div className="banner banner-bad" role="alert">
              <b>PayPal sandbox seeding failed.</b> {ws.seedError} See README → “Sandbox setup”.
            </div>
          )}
          {error && (
            <div className="banner banner-bad" role="alert" data-testid="error">
              {error}
              <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
            </div>
          )}
          {notice && (
            <div className="banner banner-note" role="status">
              {notice}
              <button onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
            </div>
          )}
        </div>
      )}

      {!ws ? (
        <div className="loading" data-testid="loading">
          <div className="spinner" />
          <p>Creating your private demo store. Placing 4 sandbox orders and a subscription in PayPal…</p>
        </div>
      ) : (
        <main className="grid">
          <Inbox
            ws={ws}
            busy={busy}
            selectedPlanId={selected}
            liveAi={!!meta?.liveAi}
            onSelectPlan={setSelected}
            onTriage={async (messageId) => {
              const r = await post(`triage:${messageId}`, "/api/triage", { messageId });
              const p = r?.workspace.plans.find((x) => x.messageId === messageId);
              if (p) setSelected(p.id);
            }}
            onCompose={async (input) => {
              const r = await post("compose", "/api/messages", input);
              const p = r?.workspace.plans.find((x) => x.messageId === r.messageId);
              if (p) setSelected(p.id);
              return !!r;
            }}
          />
          <section className="work">
            <div className="work-head">
              <h2>Proposed changes</h2>
              <p className="muted">
                {ws.plans.length === 0 ? "Nothing drafted yet. Run the agent on the inbox." : `${counts.waiting} waiting for you · ${counts.auto} handled by your mandate`}
              </p>
            </div>
            <PlanGrid
              ws={ws}
              selectedId={selected}
              onSelect={setSelected}
              onAmount={(id, amount) => post(`plan:${id}`, `/api/plans/${id}`, { action: "amount", amount })}
            />
            <PlanDetail
              ws={ws}
              plan={plan}
              busy={busy}
              onSign={(id, override) => post(`plan:${id}`, `/api/plans/${id}`, { action: "sign", override })}
              onReject={(id) => post(`plan:${id}`, `/api/plans/${id}`, { action: "reject" })}
              onAmount={(id, amount) => post(`plan:${id}`, `/api/plans/${id}`, { action: "amount", amount })}
            />
          </section>
          <AuditLog ws={ws} onSelectPlan={setSelected} />
        </main>
      )}
      <footer className="foot">
        Demo store and customers are fictional. Payments run in the PayPal sandbox with test cards; no real money moves.
      </footer>
    </div>
  );
}
