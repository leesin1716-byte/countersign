// 에이전트 실행: 메시지 하나 또는 받은편지함 전체를 변경안으로 만든다(시드 메시지는 저장된 결과 재생)
import type { NextRequest } from "next/server";
import { fail, respond, takeLiveAiCall, visitor } from "@/lib/http";
import { getWorkspace, triageInbox, triageMessage } from "@/lib/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const v = visitor(req);
  try {
    const body = (await req.json().catch(() => ({}))) as { messageId?: string };
    if (!body.messageId) return respond(await triageInbox(v.wsId, { allowLive: false }), v);
    const ws = await getWorkspace(v.wsId);
    const message = ws.messages.find((m) => m.id === body.messageId);
    if (!message) return fail("Message not found", 404);
    const notice = message.seedKey ? null : await takeLiveAiCall(v.ipKey);
    return respond(await triageMessage(v.wsId, message.id, { allowLive: !message.seedKey && !notice }), v, { notice });
  } catch (e) {
    return fail(e, 500);
  }
}
