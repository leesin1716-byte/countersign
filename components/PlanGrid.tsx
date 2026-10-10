"use client";
// AG Grid 변경안 표: 고객·요청·제안·금액(환불은 편집 가능)·정책 판정·상태·PayPal ID
import { useEffect, useMemo, useRef } from "react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import type { Plan, Workspace } from "@/lib/types";
import { ACTION_LABEL, INTENT_LABEL, VERDICT_LABEL, customerName, statusLabel, statusTone, usd } from "./format";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: "var(--font-sans), system-ui, sans-serif",
  headerFontFamily: "var(--font-sans), system-ui, sans-serif",
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 600,
  backgroundColor: "#fffdf8",
  foregroundColor: "#1d1b16",
  headerBackgroundColor: "#f3eee3",
  headerTextColor: "#5b5446",
  borderColor: "#e3dccd",
  rowHoverColor: "#f7f1e4",
  selectedRowBackgroundColor: "#e9eefc",
  accentColor: "#2340a0",
  rowHeight: 54,
  headerHeight: 38,
  wrapperBorderRadius: 10,
  spacing: 6,
});

interface Row {
  id: string;
  customer: string;
  intent: string;
  action: string;
  summary: string;
  amount: number | null;
  editable: boolean;
  verdict: Plan["policy"]["verdict"];
  status: Plan["status"];
  statusText: string;
  paypalId: string;
  source: Plan["aiSource"];
}

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export default function PlanGrid({
  ws,
  selectedId,
  onSelect,
  onAmount,
}: {
  ws: Workspace;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAmount: (id: string, amount: number) => void;
}) {
  const rows: Row[] = useMemo(
    () =>
      ws.plans.map((p) => ({
        id: p.id,
        customer: customerName(ws, p.customerKey),
        intent: INTENT_LABEL[p.proposal.intent] ?? p.proposal.intent,
        action: ACTION_LABEL[p.proposal.action],
        summary: p.proposal.summary,
        amount: p.policy.amount,
        editable: p.proposal.action === "refund" && ["awaiting_signature", "needs_review", "blocked"].includes(p.status),
        verdict: p.policy.verdict,
        status: p.status,
        statusText: statusLabel(p),
        paypalId: p.execution?.paypalId ?? "",
        source: p.aiSource,
      })),
    [ws],
  );

  const cols: ColDef<Row>[] = useMemo(
    () => [
      {
        field: "customer",
        headerName: "Customer",
        width: 138,
        cellRenderer: (p: ICellRendererParams<Row>) => (
          <span className="cell-two">
            <b>{p.data?.customer}</b>
            <span>{p.data?.intent}</span>
          </span>
        ),
      },
      {
        field: "action",
        headerName: "Proposed change",
        flex: 1,
        minWidth: 200,
        tooltipField: "summary",
        cellRenderer: (p: ICellRendererParams<Row>) => (
          <span className="cell-two">
            <b>{p.data?.action}</b>
            <span>{p.data?.summary}</span>
          </span>
        ),
      },
      {
        field: "amount",
        headerName: "Amount",
        width: 96,
        type: "rightAligned",
        editable: (p) => !!p.data?.editable,
        valueFormatter: (p) => (p.value === null || p.value === undefined ? "-" : usd(p.value)),
        valueParser: (p) => Number(String(p.newValue).replace(/[$,\s]/g, "")),
        cellClass: (p) => (p.data?.editable ? "cell-editable" : ""),
        tooltipValueGetter: (p) => (p.data?.editable ? "Double-click to edit the refund amount" : undefined),
      },
      {
        field: "statusText",
        headerName: "Status",
        width: 150,
        cellRenderer: (p: ICellRendererParams<Row>) =>
          p.data ? (
            <span className="cell-two">
              <Badge tone={statusTone(p.data.status)}>{p.data.statusText}</Badge>
              <span>{VERDICT_LABEL[p.data.verdict]}</span>
            </span>
          ) : null,
      },
      { field: "paypalId", headerName: "PayPal ID", width: 140, cellClass: "mono cell-id", tooltipField: "paypalId" },
    ],
    [],
  );

  const gridRef = useRef<AgGridReact<Row>>(null);
  useEffect(() => {
    const api = gridRef.current?.api;
    if (!api) return;
    if (selectedId) api.getRowNode(selectedId)?.setSelected(true, true);
    else api.deselectAll();
  }, [selectedId, rows]);

  if (rows.length === 0) {
    return (
      <div className="grid-empty" data-testid="grid-empty">
        <p>Six customer messages are waiting. Press <b>Run agent</b> and Claude will draft one PayPal change for each.</p>
      </div>
    );
  }

  return (
    <div className="plan-grid" data-testid="plan-grid">
      <AgGridReact<Row>
        ref={gridRef}
        theme={theme}
        rowData={rows}
        columnDefs={cols}
        getRowId={(p) => p.data.id}
        domLayout="autoHeight"
        rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
        onRowClicked={(e) => e.data && onSelect(e.data.id)}
        onFirstDataRendered={(e) => selectedId && e.api.getRowNode(selectedId)?.setSelected(true, true)}
        onCellValueChanged={(e) => {
          if (e.colDef.field === "amount" && e.data && Number.isFinite(e.newValue) && e.newValue !== e.oldValue) onAmount(e.data.id, e.newValue);
        }}
        stopEditingWhenCellsLoseFocus
        singleClickEdit={false}
        tooltipShowDelay={300}
      />
    </div>
  );
}
