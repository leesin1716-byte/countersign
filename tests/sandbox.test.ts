// 샌드박스 REST 클라이언트 오류 처리: PayPal 이 상세 없이 422 를 줄 때도 debug_id 가 메시지에 남아 추적할 수 있는지
import { afterEach, expect, it, vi } from "vitest";
import { SandboxPayPal } from "../lib/paypal/sandbox";

afterEach(() => vi.unstubAllGlobals());

it("keeps PayPal's debug_id in the error when a 422 has no details", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/v1/oauth2/token")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }))
        : new Response(JSON.stringify({ name: "UNPROCESSABLE_ENTITY", message: "UNPROCESSABLE_ENTITY", debug_id: "f00dcafe12345" }), { status: 422 }),
    ),
  );
  const err = await new SandboxPayPal("id", "secret").getOrderFacts("ORDER1").catch((e) => e);
  expect(err.status).toBe(422);
  expect(err.debugId).toBe("f00dcafe12345");
  expect(err.message).toBe("GET /v2/checkout/orders/ORDER1: UNPROCESSABLE_ENTITY - UNPROCESSABLE_ENTITY (debug_id f00dcafe12345)");
});
