// 변경안 처리: 서명(실행)·거절·환불 금액 수정
import type { NextRequest } from "next/server";
import { fail, respond, visitor } from "@/lib/http";
import { editAmount, rejectPlan, signPlan } from "@/lib/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const v = visitor(req);
  const { id } = await ctx.params;
  try {
    const body = (await req.json()) as { action?: string; amount?: number; override?: boolean };
    if (body.action === "sign") return respond(await signPlan(v.wsId, id, { override: !!body.override }), v);
    if (body.action === "reject") return respond(await rejectPlan(v.wsId, id), v);
    if (body.action === "amount") return respond(await editAmount(v.wsId, id, Number(body.amount)), v);
    return fail("Unknown action");
  } catch (e) {
    return fail(e);
  }
}
