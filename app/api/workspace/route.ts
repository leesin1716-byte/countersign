// 방문자 워크스페이스 조회(없으면 시드하고 PayPal 샌드박스에 주문·구독을 만든다)
import type { NextRequest } from "next/server";
import { fail, respond, takeReset, visitor } from "@/lib/http";
import { getWorkspace } from "@/lib/service";
import { loadWorkspace } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const v = visitor(req);
  try {
    if (!(await loadWorkspace(v.wsId)) && !(await takeReset(v.ipKey))) return fail("Too many new demo workspaces from this network today.", 429);
    return respond(await getWorkspace(v.wsId), v);
  } catch (e) {
    return fail(e, 500);
  }
}
