/**
 * Scheduled-publish E2E: approve the final gate with a "publish no earlier
 * than" time ~90s out; verify the production parks in `scheduled` and then
 * publishes automatically at the scheduled time.
 */
import { chromium } from "playwright";

const BASE = process.env.COCKPIT_URL ?? "http://localhost:3000";
const IDEA = process.argv[2] ?? "How your fridge hums itself into resonance";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({
  httpCredentials: { username: "operator", password: "test-pass-123" },
  viewport: { width: 1400, height: 1000 },
});
page.setDefaultTimeout(30_000);
const log = (m) => console.log(`[schedule] ${m}`);

try {
  await page.goto(`${BASE}/ideas`);
  const ideaRow = page.locator("tr", { hasText: IDEA }).first();
  log("greenlighting…");
  await ideaRow.getByRole("button", { name: /Greenlight/ }).click();
  await page.waitForLoadState("networkidle");

  log("waiting for script gate…");
  let reviewHref = null;
  for (let i = 0; i < 60; i++) {
    await page.goto(`${BASE}/gates`);
    const link = page.locator('tr', { hasText: IDEA }).locator('a.btn:has-text("Review")').first();
    if (await link.count()) {
      reviewHref = await link.getAttribute("href");
      break;
    }
    await page.waitForTimeout(1000);
  }
  if (!reviewHref) throw new Error("script gate never appeared");

  await page.goto(`${BASE}${reviewHref}`);
  log("approving script…");
  await page.getByPlaceholder(/Editorial notes/).fill("ok");
  await page.getByRole("button", { name: /Approve/ }).click();

  log("waiting for final gate…");
  let finalGate = false;
  for (let i = 0; i < 180; i++) {
    await page.goto(`${BASE}${reviewHref}`);
    if (await page.locator("text=Final review — decision required").count()) {
      finalGate = true;
      break;
    }
    await page.waitForTimeout(2000);
  }
  if (!finalGate) throw new Error("final gate never appeared");

  // approve with a schedule ~90s out (datetime-local wants local time)
  const t = new Date(Date.now() + 90_000);
  const local = new Date(t.getTime() - t.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  log(`approving final gate scheduled for ${t.toISOString()}…`);
  await page.locator('input[type="datetime-local"]').fill(local);
  await page.getByPlaceholder(/Editorial notes/).fill("release on schedule");
  await page.getByRole("button", { name: /Approve/ }).click();

  log("expecting status=scheduled…");
  let sawScheduled = false;
  for (let i = 0; i < 30; i++) {
    await page.goto(`${BASE}${reviewHref}`);
    const badges = await page.locator(".badge").allInnerTexts();
    if (badges.includes("scheduled")) { sawScheduled = true; break; }
    if (badges.includes("published")) throw new Error("published immediately — schedule ignored");
    await page.waitForTimeout(1000);
  }
  if (!sawScheduled) throw new Error("never saw scheduled status");
  log("parked in scheduled ✓ — waiting for the scheduled time…");

  let published = false;
  for (let i = 0; i < 90; i++) {
    await page.goto(`${BASE}${reviewHref}`);
    if (await page.locator("text=Publication").count()) { published = true; break; }
    await page.waitForTimeout(3000);
  }
  if (!published) throw new Error("never published after schedule");
  const publishedAt = new Date();
  if (publishedAt.getTime() < t.getTime() - 5_000) throw new Error("published before schedule");
  log(`published after scheduled time ✓ (${publishedAt.toISOString()})`);
  log("OK — scheduled publishing works");
} finally {
  await browser.close();
}
