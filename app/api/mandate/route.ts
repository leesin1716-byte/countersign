// 위임 한도(자동 실행 범위) 변경
import type { NextRequest } from "next/server";
import { fail, respond, visitor } from "@/lib/http";
import { updateMandate } from "@/lib/service";
import type { Mandate } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest) {
  const v = visitor(req);
  try {
    return respond(await updateMandate(v.wsId, (await req.json()) as Partial<Mandate>), v);
  } catch (e) {
    return fail(e);
  }
}
