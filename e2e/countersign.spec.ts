// 브라우저 E2E: 시드 → 에이전트 실행 → 자동 실행 확인 → 서명 실행 → 차단 → 직접 쓴 메시지 → 초기화(모의 PayPal·모의 AI)
import { expect, test, type Page } from "@playwright/test";

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("run-agent")).toBeEnabled({ timeout: 60_000 });
}

const row = (page: Page, name: string) => page.getByTestId("plan-grid").locator('[role="row"]', { hasText: name });

test("a first visit loads one workspace, so the cookie and the screen agree", async ({ page }) => {
  const loads: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/workspace") loads.push(r.method());
  });
  await ready(page);
  await page.waitForLoadState("networkidle");
  expect(loads).toEqual(["GET"]);
});

test("seller triages the inbox and countersigns a refund", async ({ page }) => {
  await ready(page);
  await expect(page.getByTestId("grid-empty")).toBeVisible();
  await page.getByTestId("run-agent").click();
  await expect(page.getByTestId("plan-grid")).toBeVisible();
  await expect(row(page, "Maya Okafor")).toContainText("Done by mandate");
  await expect(row(page, "Maya Okafor")).toContainText("$4.80");
  await expect(row(page, "Tom Becker")).toContainText("Done by mandate");
  await expect(row(page, "Alex Mercer")).toContainText("Needs review");

  await page.getByTestId("msg-broken-platter").getByRole("button").click();
  await expect(page.getByTestId("plan-detail")).toContainText("Refund");
  await expect(page.getByTestId("checks")).toContainText("Within refundable balance");
  await page.getByTestId("sign").click();
  await expect(page.getByTestId("receipt")).toContainText("Countersigned and executed");
  await expect(row(page, "Daniel Reyes")).toContainText("Countersigned");
  await expect(page.getByTestId("audit")).toContainText("Executed after countersignature");
});

test("policy blocks an edited refund above what PayPal holds, then allows a partial one", async ({ page }) => {
  await ready(page);
  await page.getByTestId("run-agent").click();
  await page.getByTestId("msg-broken-platter").getByRole("button").click();
  await page.getByTestId("amount-input").fill("500");
  await page.getByRole("button", { name: "Re-check" }).click();
  await expect(page.getByTestId("plan-status")).toHaveText("Blocked by policy");
  await expect(page.getByTestId("sign")).toHaveCount(0);
  await page.getByTestId("amount-input").fill("60");
  await page.getByRole("button", { name: "Re-check" }).click();
  await expect(page.getByTestId("plan-status")).toHaveText("Awaiting signature");
  await expect(page.getByTestId("sign")).toContainText("$60.00");
});

test("the injection attempt cannot be signed and can be rejected", async ({ page }) => {
  await ready(page);
  await page.getByTestId("run-agent").click();
  await page.getByTestId("msg-refund-now").getByRole("button").click();
  await expect(page.getByTestId("plan-detail")).toContainText("prompt_injection");
  await expect(page.getByTestId("sign")).toHaveCount(0);
  await page.getByTestId("reject").click();
  await expect(page.getByTestId("plan-status")).toHaveText("Rejected");
});

test("a message written in the demo is triaged, and reset starts over", async ({ page }) => {
  await ready(page);
  await page.getByTestId("compose-toggle").click();
  await page.getByTestId("compose-from").selectOption("tom");
  await page.getByTestId("compose-body").fill("Please pause my subscription for a month, I'm travelling.");
  await page.getByTestId("compose-send").click();
  await expect(page.getByTestId("plan-detail")).toContainText("Pause subscription");
  await page.getByTestId("reset").click();
  await expect(page.getByTestId("grid-empty")).toBeVisible({ timeout: 60_000 });
});
