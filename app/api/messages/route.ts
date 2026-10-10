// 데모에서 직접 쓴 고객 메시지를 받은편지함에 넣고 바로 에이전트를 돌린다(실호출은 횟수 제한)
import type { NextRequest } from "next/server";
import { fail, respond, takeLiveAiCall, visitor } from "@/lib/http";
import { addMessage, triageMessage } from "@/lib/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const v = visitor(req);
  try {
    const body = (await req.json()) as { customerKey?: string; subject?: string; body?: string };
    const { messageId } = await addMessage(v.wsId, { customerKey: String(body.customerKey ?? ""), subject: String(body.subject ?? ""), body: String(body.body ?? "") });
    const notice = await takeLiveAiCall(v.ipKey);
    return respond(await triageMessage(v.wsId, messageId, { allowLive: !notice }), v, { notice, messageId });
  } catch (e) {
    return fail(e);
  }
}
