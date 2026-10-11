// 실제 PayPal 샌드박스 E2E: 시드 6건을 승인→실행→PayPal 재조회→ID 반영→감사 로그→초기화까지 화면으로 확인한다(npm run test:e2e:sandbox)
import { expect, test, type Page } from "@playwright/test";

const row = (page: Page, name: string) => page.getByTestId("plan-grid").locator('[role="row"]', { hasText: name });
const open = (page: Page, seedKey: string) => page.getByTestId(`msg-${seedKey}`).getByRole("button").click();
const NOT_MOCK = /^(?!.*MOCK).+$/;

async function orderIds(page: Page): Promise<string> {
  const ws = await (await page.request.get("/api/workspace")).json();
  return ws.workspace.orders.map((o: { paypalOrderId?: string }) => o.paypalOrderId).join(",");
}

test("all six seeded flows run end to end on the real PayPal sandbox", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("run-agent")).toBeEnabled({ timeout: 120_000 });
  await expect(page.getByTestId("paypal-mode")).toContainText("PayPal Sandbox · live API");
  await expect(page.locator(".banner-bad")).toHaveCount(0);
  await expect(page.getByTestId("audit")).toContainText("Sandbox seeded");
  await expect(page.getByTestId("audit")).not.toContainText("MOCK");

  await page.getByTestId("run-agent").click();
  await expect(page.getByTestId("plan-grid")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("run-agent")).toContainText("Inbox triaged");

  // 1. Late delivery: 10% courtesy refund inside the mandate runs on its own; PayPal is re-read afterwards.
  await expect(row(page, "Maya Okafor")).toContainText("Done by mandate");
  await expect(row(page, "Maya Okafor")).toContainText("$4.80");
  await open(page, "late-gift");
  await expect(page.getByTestId("receipt")).toContainText("Executed under your mandate");
  await expect(page.getByTestId("receipt")).toContainText("PayPal now shows $4.80 refunded of $48.00");
  await expect(page.getByTestId("receipt").locator(".mono")).toHaveText(/^Refund \w+ · COMPLETED$/);

  // 4. Pause request: subscription suspended under the mandate, status read back from PayPal.
  await expect(row(page, "Tom Becker")).toContainText("Done by mandate");
  await open(page, "pause-box");
  await expect(page.getByTestId("receipt").locator(".mono")).toHaveText(/^Subscription I-\w+ · SUSPENDED$/);

  // 5. Delivered order: reply only, no PayPal change.
  await expect(row(page, "Lena Kowalski")).toContainText("Done by mandate");
  await open(page, "where-vase");
  await expect(page.getByTestId("receipt")).toContainText("No PayPal change was needed");

  // 2. Damaged item: full refund waits for the countersignature, then executes.
  await open(page, "broken-platter");
  await expect(page.getByTestId("plan-status")).toHaveText("Awaiting signature");
  await expect(page.getByTestId("checks")).toContainText("Within refundable balance");
  await page.getByTestId("sign").click();
  await expect(page.getByTestId("receipt")).toContainText("Countersigned and executed");
  await expect(page.getByTestId("receipt")).toContainText("PayPal now shows $129.00 refunded of $129.00");
  await expect(row(page, "Daniel Reyes")).toContainText("Countersigned");
  if (process.env.SCREENSHOT) {
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.screenshot({ path: process.env.SCREENSHOT, fullPage: true });
  }

  // 3. Wholesale quote: invoice computed from the price list, sent through PayPal Invoicing after signing.
  await open(page, "wholesale");
  await expect(page.getByTestId("plan-status")).toHaveText("Awaiting signature");
  await expect(page.getByTestId("sign")).toContainText("$1,296.00");
  await page.getByTestId("sign").click();
  await expect(page.getByTestId("receipt")).toContainText("Countersigned and executed");
  await expect(page.getByTestId("receipt").locator(".mono")).toHaveText(/^Invoice INV2-[\w-]+ · \w+$/);
  await expect(page.getByTestId("receipt")).toContainText("for $1296.00 sent to priya@cornersteam.example");

  // 6. Injection attempt: held for review, cannot be signed, rejected.
  await open(page, "refund-now");
  await expect(page.getByTestId("plan-status")).toHaveText("Needs review");
  await expect(page.getByTestId("plan-detail")).toContainText("prompt_injection");
  await page.getByTestId("reject").click();
  await expect(page.getByTestId("plan-status")).toHaveText("Rejected");

  // Every PayPal ID in the grid and the audit log is a sandbox ID, not a simulator one.
  const ids = await page.getByTestId("plan-grid").locator(".cell-id").allInnerTexts();
  expect(ids.filter(Boolean)).toHaveLength(4);
  for (const id of ids.filter(Boolean)) expect(id).toMatch(NOT_MOCK);
  const audit = page.getByTestId("audit");
  await expect(audit).toContainText("Executed under mandate");
  await expect(audit).toContainText("Executed after countersignature");
  await expect(audit).toContainText("Rejected");
  await expect(audit).not.toContainText("Execution failed");

  // Reset seeds fresh sandbox orders.
  const before = await orderIds(page);
  await page.getByTestId("reset").click();
  await expect(page.getByTestId("grid-empty")).toBeVisible({ timeout: 120_000 });
  await expect(page.locator(".banner-bad")).toHaveCount(0);
  const after = await orderIds(page);
  expect(after).not.toBe(before);
  expect(after.split(",").every((id) => id.length > 0)).toBe(true);
});
