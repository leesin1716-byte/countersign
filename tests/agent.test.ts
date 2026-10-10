// 에이전트 루프 테스트: 각본대로 움직이는 가짜 LLM 으로 도구 실행·고객 범위 제한·잘못된 변경안 재시도·이미지 첨부를 확인
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { runAgent, runTool, type LlmClient } from "../lib/agent/agent";
import { MockPayPal } from "../lib/paypal/mock";
import { provision, seedData } from "../lib/seed";

async function setup() {
  const paypal = new MockPayPal();
  const ws = seedData("ag1", "mock");
  await provision(ws, paypal);
  return { ws, paypal };
}

function scripted(turns: { name: string; input: Record<string, unknown> }[][]): LlmClient & { requests: Anthropic.MessageCreateParamsNonStreaming[] } {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  return {
    requests,
    async create(params) {
      requests.push(structuredClone(params));
      const calls = turns[i++] ?? [];
      return {
        id: `msg_${i}`,
        type: "message",
        role: "assistant",
        model: params.model,
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 },
        content: calls.map((c, j) => ({ type: "tool_use", id: `tu_${i}_${j}`, name: c.name, input: c.input })),
      } as unknown as Anthropic.Message;
    },
  };
}

const proposal = {
  intent: "damaged_item",
  action: "refund",
  order_ref: "HP-1051",
  refund_amount_usd: 129,
  summary: "Full refund for broken platter",
  evidence: [{ source: "attachment", text: "Platter cracked in two" }],
  reply_draft: "Sorry!",
  risk_flags: [],
  confidence: 0.9,
};

describe("agent loop", () => {
  it("runs read-only tools, then returns a validated proposal", async () => {
    const { ws, paypal } = await setup();
    const msg = ws.messages.find((m) => m.seedKey === "broken-platter")!;
    const llm = scripted([[{ name: "get_order", input: { order_ref: "HP-1051" } }], [{ name: "submit_proposal", input: proposal }]]);
    const run = await runAgent({ ws, message: msg, paypal, llm, model: "test-model" });
    expect(run.proposal.refundAmount).toBe(129);
    expect(run.trace[0].tool).toBe("get_order");
    expect(JSON.parse(run.trace[0].output).paypal.captured_usd).toBe(129);
    // The photo is sent to the model as an image block.
    const first = llm.requests[0].messages[0].content as Anthropic.ContentBlockParam[];
    expect(first[0].type).toBe("image");
    expect(llm.requests[0].tool_choice).toEqual({ type: "any" });
    expect(run.usage).toEqual({ input: 200, output: 40 });
  });

  it("keeps the customer message inside an untrusted-data block", async () => {
    const { ws, paypal } = await setup();
    const msg = ws.messages.find((m) => m.seedKey === "refund-now")!;
    const llm = scripted([[{ name: "submit_proposal", input: { ...proposal, action: "escalate", order_ref: "HP-1038", refund_amount_usd: null } }]]);
    await runAgent({ ws, message: msg, paypal, llm });
    const text = (llm.requests[0].messages[0].content as Anthropic.TextBlockParam[]).find((b) => b.type === "text")!.text;
    expect(text).toMatch(/<customer_message>[\s\S]*SYSTEM NOTE[\s\S]*<\/customer_message>/);
  });

  it("feeds a schema error back and accepts the corrected proposal", async () => {
    const { ws, paypal } = await setup();
    const msg = ws.messages.find((m) => m.seedKey === "broken-platter")!;
    const llm = scripted([[{ name: "submit_proposal", input: { ...proposal, action: "wire_money" } }], [{ name: "submit_proposal", input: proposal }]]);
    const run = await runAgent({ ws, message: msg, paypal, llm });
    expect(run.proposal.action).toBe("refund");
    const retry = llm.requests[1].messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(retry[0].is_error).toBe(true);
  });

  it("forces the proposal on the last turn", async () => {
    const { ws, paypal } = await setup();
    const msg = ws.messages.find((m) => m.seedKey === "broken-platter")!;
    const lookups = Array.from({ length: 5 }, () => [{ name: "get_price_list", input: {} }]);
    const llm = scripted([...lookups, [{ name: "submit_proposal", input: proposal }]]);
    await runAgent({ ws, message: msg, paypal, llm });
    expect(llm.requests[5].tool_choice).toEqual({ type: "tool", name: "submit_proposal" });
  });

  it("scopes lookups to the sender", async () => {
    const { ws, paypal } = await setup();
    const maya = ws.messages.find((m) => m.seedKey === "late-gift")!;
    const other = JSON.parse(await runTool(ws, maya, paypal, "get_order", { order_ref: "HP-1038" }));
    expect(other.error).toMatch(/No order/);
    const own = JSON.parse(await runTool(ws, maya, paypal, "get_order", { order_ref: "hp-1042" }));
    expect(own.carrier.status).toBe("delivered");
    const records = JSON.parse(await runTool(ws, maya, paypal, "list_customer_records", {}));
    expect(records.orders.map((o: { ref: string }) => o.ref)).toEqual(["HP-1042"]);
  });
});

describe("recorded seed runs", () => {
  it("every cached proposal is valid and replays its lookups against the current PayPal objects", async () => {
    const { analyze } = await import("../lib/agent");
    const cache = (await import("../lib/agent/seed-cache.json")).default as Record<string, unknown>;
    const { ws, paypal } = await setup();
    const prev = process.env.AI_SEED_MODE;
    process.env.AI_SEED_MODE = "cache";
    try {
      for (const key of Object.keys(cache)) {
        const msg = ws.messages.find((m) => m.seedKey === key)!;
        const run = await analyze(ws, msg, paypal, { allowLive: false });
        expect(run.source).toBe("cached");
        expect(run.trace.at(-1)?.tool).toBe("submit_proposal");
        for (const step of run.trace.slice(0, -1)) expect(step.output).not.toMatch(/"error"/);
        expect(JSON.stringify(run.proposal)).not.toMatch(/MOCK/);
      }
    } finally {
      process.env.AI_SEED_MODE = prev;
    }
  });
});

describe("proposal validation", () => {
  it("rejects a refund without an order or amount", async () => {
    const { toProposal } = await import("../lib/agent/agent");
    expect(() => toProposal({ ...proposal, order_ref: null })).toThrow(/order_ref/);
    expect(() => toProposal({ ...proposal, refund_amount_usd: null })).toThrow(/refund_amount_usd/);
    expect(() => toProposal({ ...proposal, action: "suspend_subscription", subscription_ref: null })).toThrow(/subscription_ref/);
    expect(toProposal({ ...proposal, action: "reply_only", order_ref: null, refund_amount_usd: null }).action).toBe("reply_only");
  });
});
