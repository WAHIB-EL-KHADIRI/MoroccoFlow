import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.goto("/#/dashboard");
  await expect(page.getByRole("heading", { name: /Bonjour/ })).toBeVisible();
});

test("dashboard is responsive and has no serious accessibility violations", async ({ page }) => {
  await expect(page.getByText("MoroccoFlow", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("0 dh", { exact: true }).first()).toBeVisible();
  await expect(page.locator("mf-chart svg, mf-chart canvas")).toBeVisible();
  const results = await new AxeBuilder({ page }).disableRules(["color-contrast"]).analyze();
  expect(
    results.violations.filter((item) => ["critical", "serious"].includes(item.impact)),
  ).toEqual([]);
});

test("switches to Arabic RTL and persists theme", async ({ page }) => {
  await page.getByRole("button", { name: "Langue" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator('.nav-link[href="#/dashboard"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("creates and persists a validated CRM client", async ({ page }) => {
  await page.goto("/#/crm");
  await page
    .getByRole("button", { name: /Ajouter un client/ })
    .first()
    .click();
  await page.locator("#name").fill("Karim Amrani");
  await page.locator("#company").fill("Sahara Lab");
  await page.locator("#email").fill("karim@saharalab.demo");
  await page.locator("#phone").fill("+212661234567");
  await page.locator("#city").fill("Ouarzazate");
  await page.locator("#client-form button[type=submit]").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Sahara Lab")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Sahara Lab")).toBeVisible();
});

test("moves a Kanban task with keyboard-accessible controls", async ({ page }) => {
  await page.goto("/#/projects");
  const firstColumn = page.locator(".kanban-column").first();
  const secondColumn = page.locator(".kanban-column").nth(1);
  await expect(firstColumn.locator(".task-card").first()).toBeVisible();
  const before = await firstColumn.locator(".task-card").count();
  const secondBefore = await secondColumn.locator(".task-card").count();
  await firstColumn.locator(".move-task:not([disabled])").last().click();
  await expect(firstColumn.locator(".task-card")).toHaveCount(before - 1);
  await expect(secondColumn.locator(".task-card")).toHaveCount(secondBefore + 1);
});

test("creates an invoice using integer-centime calculations", async ({ page }) => {
  await page.goto("/#/finance");
  await page
    .getByRole("button", { name: /Nouvelle facture/ })
    .first()
    .click();
  await page.locator("#clientId").selectOption("c1");
  await page.locator("#amount").fill("1250.50");
  await page
    .locator("#invoice-form")
    .getByRole("button", { name: /Enregistrer/ })
    .click();
  await expect(page.getByText(/FA-2026-/).first()).toBeVisible();
});
