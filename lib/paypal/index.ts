// 환경 변수에 따라 샌드박스 또는 모의 PayPal 을 고르는 진입점
import { MockPayPal } from "./mock";
import { SandboxPayPal } from "./sandbox";
import type { PayPalPort } from "./port";

let mock: MockPayPal | null = null;

export function paypalMode(): "sandbox" | "mock" {
  const forced = process.env.PAYPAL_MODE;
  if (forced === "mock" || forced === "sandbox") return forced;
  return process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? "sandbox" : "mock";
}

export function getPayPal(mode = paypalMode()): PayPalPort {
  if (mode === "sandbox") {
    return new SandboxPayPal(process.env.PAYPAL_CLIENT_ID ?? "", process.env.PAYPAL_CLIENT_SECRET ?? "");
  }
  mock ??= new MockPayPal();
  return mock;
}

export { PayPalError } from "./port";
export type { PayPalPort } from "./port";
