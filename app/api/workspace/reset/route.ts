// 데모 초기화: 새 샌드박스 주문·구독으로 워크스페이스를 다시 시드한다
import type { NextRequest } from "next/server";
import { fail, respond, takeReset, visitor } from "@/lib/http";
import { resetWorkspace } from "@/lib/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const v = visitor(req);
  try {
    if (!(await takeReset(v.ipKey))) return fail("Reset limit reached for today.", 429);
    return respond(await resetWorkspace(v.wsId), v);
  } catch (e) {
    return fail(e, 500);
  }
}
