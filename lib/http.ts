// API 라우트 공통 도우미: 방문자 워크스페이스 쿠키, 응답 형태, 실호출 AI·시드 횟수 제한
import { createHash, randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { liveAiAvailable } from "./agent";
import { paypalMode } from "./paypal";
import { bumpCounter } from "./store";
import type { Workspace } from "./types";

const COOKIE = "cs_ws";
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const LIMITS = {
  aiPerVisitorDaily: num(process.env.LIVE_AI_PER_VISITOR_DAILY, 4),
  aiGlobalDaily: num(process.env.LIVE_AI_GLOBAL_DAILY, 25),
  aiTotal: num(process.env.LIVE_AI_TOTAL_LIMIT, 400),
  resetsPerVisitorDaily: num(process.env.RESETS_PER_VISITOR_DAILY, 15),
};

export function visitor(req: NextRequest): { wsId: string; isNew: boolean; ipKey: string } {
  const existing = req.cookies.get(COOKIE)?.value;
  const valid = existing && /^[a-f0-9]{16}$/.test(existing);
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
  const ipKey = createHash("sha256").update(ip).digest("hex").slice(0, 12);
  return { wsId: valid ? existing! : randomUUID().replace(/-/g, "").slice(0, 16), isNew: !valid, ipKey };
}

export function respond(ws: Workspace, v: { wsId: string; isNew: boolean }, extra: Record<string, unknown> = {}) {
  const res = NextResponse.json({
    workspace: ws,
    meta: { paypalMode: ws.paypalMode, liveAi: liveAiAvailable(), serverPaypalMode: paypalMode(), limits: { aiPerVisitorDaily: LIMITS.aiPerVisitorDaily } },
    ...extra,
  });
  if (v.isNew) {
    res.cookies.set(COOKIE, v.wsId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30, secure: process.env.NODE_ENV === "production" });
  }
  return res;
}

export function fail(e: unknown, status = 400) {
  return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status });
}

/** Spend one live-AI call if every budget allows it. Returns a reason when it does not. */
export async function takeLiveAiCall(ipKey: string): Promise<string | null> {
  if (!liveAiAvailable()) return "Live AI is off on this deployment, so the rules-based fallback answered.";
  if (!(await bumpCounter(`ai-ip-${ipKey}`, LIMITS.aiPerVisitorDaily)).ok) return `You've used today's ${LIMITS.aiPerVisitorDaily} live AI runs, so the rules-based fallback answered.`;
  if (!(await bumpCounter("ai-global", LIMITS.aiGlobalDaily)).ok) return "Today's shared live AI budget is used up, so the rules-based fallback answered.";
  if (!(await bumpCounter("ai-total", LIMITS.aiTotal, false)).ok) return "The demo's live AI budget is used up, so the rules-based fallback answered.";
  return null;
}

export async function takeReset(ipKey: string): Promise<boolean> {
  return (await bumpCounter(`reset-${ipKey}`, LIMITS.resetsPerVisitorDaily)).ok;
}
