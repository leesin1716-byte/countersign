"use client";
// 위임 한도 막대: 판매자가 서명 없이 자동 실행을 허락하는 범위를 보고 바꾼다
import { useEffect, useState } from "react";
import type { Mandate } from "@/lib/types";

export default function MandateBar({ mandate, busy, onSave }: { mandate: Mandate; busy: boolean; onSave: (m: Partial<Mandate>) => void }) {
  const [draft, setDraft] = useState(mandate);
  useEffect(() => setDraft(mandate), [mandate]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(mandate);

  return (
    <form
      className="mandate"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
      data-testid="mandate"
    >
      <span className="mandate-title">Your mandate</span>
      <span className="mandate-text">
        Refund on my behalf up to
        <span className="field">
          $<input type="number" min={0} max={500} step={1} value={draft.autoRefundMaxUsd} onChange={(e) => setDraft({ ...draft, autoRefundMaxUsd: Number(e.target.value) })} aria-label="Auto-refund dollar limit" />
        </span>
        and
        <span className="field">
          <input type="number" min={0} max={100} step={1} value={draft.autoRefundMaxPct} onChange={(e) => setDraft({ ...draft, autoRefundMaxPct: Number(e.target.value) })} aria-label="Auto-refund percent limit" />%
        </span>
        of the order.
      </span>
      <label className="toggle">
        <input type="checkbox" checked={draft.autoSuspendSubscriptions} onChange={(e) => setDraft({ ...draft, autoSuspendSubscriptions: e.target.checked })} />
        Pause subscriptions on request
      </label>
      <label className="toggle">
        <input type="checkbox" checked={draft.autoReplyOnly} onChange={(e) => setDraft({ ...draft, autoReplyOnly: e.target.checked })} />
        Reply-only items
      </label>
      <span className="mandate-note">Invoices and anything else always wait for your signature.</span>
      {dirty && (
        <button className="btn btn-small btn-primary" disabled={busy}>
          Save mandate
        </button>
      )}
    </form>
  );
}
