// 메시지 분석 진입점: 시드 메시지는 저장된 Haiku 결과를 재생하고, 새 메시지는 실호출(한도 내) 또는 모의 에이전트로 처리한다
import Anthropic from "@anthropic-ai/sdk";
import seedCache from "./seed-cache.json";
import { DEFAULT_MODEL, runAgent, runTool, toProposal, type AgentRun, type LlmClient } from "./agent";
import { mockProposal } from "./mock";
import type { PayPalPort } from "../paypal/port";
import type { InboxMessage, Workspace } from "../types";

interface CacheEntry {
  model: string;
  recordedAt: string;
  proposal: unknown;
  calls: { tool: string; input: Record<string, unknown> }[];
}

const CACHE = seedCache as Record<string, CacheEntry>;

export function liveAiAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY && process.env.AI_MODE !== "mock";
}

let client: LlmClient | null = null;
export function anthropicClient(): LlmClient {
  if (!client) {
    const sdk = new Anthropic({ maxRetries: 2, timeout: 60_000 });
    client = { create: (p) => sdk.messages.create(p) };
  }
  return client;
}

export type AiSource = "live" | "cached" | "mock";

export async function analyze(
  ws: Workspace,
  message: InboxMessage,
  paypal: PayPalPort,
  opts: { allowLive: boolean; llm?: LlmClient },
): Promise<AgentRun & { source: AiSource }> {
  // AI_SEED_MODE: "cache" (default) replays recorded runs; "rules" uses the fallback (tests). Re-record with scripts/record-seed-cache.ts.
  const seedMode = process.env.AI_SEED_MODE ?? "cache";
  const cached = message.seedKey && seedMode === "cache" ? CACHE[message.seedKey] : undefined;
  if (cached) {
    // Replay the recorded tool calls against today's PayPal objects so the evidence is live.
    const trace = [];
    for (const call of cached.calls) {
      let output: string;
      try {
        output = await runTool(ws, message, paypal, call.tool, call.input);
      } catch (e) {
        output = JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
      trace.push({ tool: call.tool, input: call.input, output });
    }
    trace.push({ tool: "submit_proposal", input: {}, output: "accepted" });
    return { proposal: toProposal(cached.proposal), trace, model: cached.model, usage: { input: 0, output: 0 }, source: "cached" };
  }
  if (opts.allowLive && (opts.llm || liveAiAvailable())) {
    const run = await runAgent({ ws, message, paypal, llm: opts.llm ?? anthropicClient(), model: DEFAULT_MODEL });
    return { ...run, source: "live" };
  }
  return { proposal: mockProposal(ws, message), trace: [], model: "rules (no AI key)", usage: { input: 0, output: 0 }, source: "mock" };
}
