/**
 * Build #3.2 E2E: after analytics ingest, a published video's drill-down page
 * shows a real retention curve plus AI hook + script analysis panels.
 *
 * Requires the full stack up (cockpit + worker + Inngest + Postgres), same as
 * the other phaseN tests. Run analytics ingest twice: the first pass snapshots
 * views, the second (once views ≥ threshold) fires analysis/requested, which the
 * worker processes into the hook/script analyses this test asserts.
 */
import { chromium } from "playwright";

const BASE = process.env.COCKPIT_URL ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? ".";
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROME ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({
  httpCredentials: { username: "operator", password: "test-pass-123" },
  viewport: { width: 1400, height: 1100 },
});
page.setDefaultTimeout(30_000);
const log = (m) => console.log(`[analysis] ${m}`);

try {
  // 1) drive analytics ingestion a couple of times to accrue views + trigger analysis
  for (let pass = 0; pass < 2; pass++) {
    await page.goto(`${BASE}/alerts`);
    await page.getByRole("button", { name: /Run analytics ingest now/ }).click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
  }
  log("analytics ingested ✓");

  // 2) open a channel → Videos tab → first published video drill-down
  await page.goto(`${BASE}/channels`);
  await page.locator("table a").first().click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Videos" }).click();
  const videoLink = page.locator('a[href*="/videos/"]').first();
  if (!(await videoLink.count())) throw new Error("no published video links in the Videos tab");
  await videoLink.click();
  await page.waitForLoadState("networkidle");
  log("on video drill-down ✓");

  // 3) retention curve renders
  if (!(await page.locator("h3:has-text('Retention curve')").count())) {
    throw new Error("retention curve panel missing");
  }

  // 4) poll for the AI analysis to land (worker processes the event async)
  let analysed = false;
  for (let i = 0; i < 40; i++) {
    await page.reload();
    const pending = await page.locator("text=Analysis pending").count();
    const hookPanel = await page.locator("h3:has-text('Hook analysis')").count();
    const scriptPanel = await page.locator("h3:has-text('Script analysis')").count();
    if (hookPanel && scriptPanel && pending === 0) {
      analysed = true;
      break;
    }
    await page.waitForTimeout(3000);
  }
  if (!analysed) throw new Error("hook/script analysis did not populate on the drill-down");
  log("hook + script analysis rendered ✓");

  // 5) the beat table shows holding/leaking flags
  if (!(await page.locator("td:has-text('holding'), td:has-text('leaking')").count())) {
    throw new Error("beat-by-beat holding/leaking flags missing");
  }
  await page.screenshot({ path: `${SHOTS}/analysis-drilldown.png`, fullPage: true });

  log("OK — build #3.2 per-video analysis flow passed");
} finally {
  await browser.close();
}
