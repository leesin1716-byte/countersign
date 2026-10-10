"use client";
// 감사 로그: 에이전트·정책·판매자·PayPal 의 모든 단계를 시간순 장부로 보여준다
import type { Workspace } from "@/lib/types";
import { time } from "./format";

const ACTOR = { agent: "Agent", policy: "Policy", seller: "You", paypal: "PayPal", system: "System" } as const;

export default function AuditLog({ ws, onSelectPlan }: { ws: Workspace; onSelectPlan: (id: string) => void }) {
  return (
    <aside className="audit" aria-label="Audit log">
      <div className="panel-head">
        <h2>Audit log</h2>
        <span className="muted">{ws.audit.length} entries</span>
      </div>
      <ol className="ledger" data-testid="audit">
        {ws.audit.map((a, i) => (
          <li key={i} className={`ledger-${a.actor}`}>
            <div className="ledger-top">
              <span className="who">{ACTOR[a.actor]}</span>
              <span className="when">{time(a.at)}</span>
            </div>
            <p className="what">
              {a.planId ? (
                <button className="linkish" onClick={() => onSelectPlan(a.planId!)}>
                  {a.event}
                </button>
              ) : (
                a.event
              )}
            </p>
            <p className="detail-line">{a.detail}</p>
            {a.paypalId && <p className="mono small">{a.paypalId}</p>}
          </li>
        ))}
      </ol>
    </aside>
  );
}
