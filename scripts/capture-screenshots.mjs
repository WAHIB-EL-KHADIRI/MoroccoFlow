import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const baseURL = process.env.APP_URL || "http://127.0.0.1:4173";
await mkdir("docs/screenshots", { recursive: true });
const browser = await chromium.launch();

const desktop = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
});
await desktop.goto(`${baseURL}/#/dashboard`);
await desktop.locator("mf-chart svg, mf-chart canvas").waitFor();
await desktop.screenshot({ path: "docs/screenshots/dashboard-light.png", fullPage: true });
await desktop.goto(`${baseURL}/#/projects`);
await desktop.locator(".kanban").waitFor();
await desktop.screenshot({ path: "docs/screenshots/kanban.png", fullPage: true });

const mobile = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
});
await mobile.goto(`${baseURL}/#/dashboard`);
await mobile.getByRole("button", { name: "Langue" }).click();
await mobile.getByRole("button", { name: "المظهر" }).click();
await mobile.screenshot({ path: "docs/screenshots/mobile-arabic-dark.png", fullPage: true });

await browser.close();
