/**
 * Build #4 E2E: the meta-analysis engine populates the shared pattern store and
 * the cockpit surfaces it. Kicks a market scan from the Market intel page, waits
 * for the worker to ingest + analyse external content into patterns, then
 * asserts the Rising angles / hook patterns render and a channel's "What's
 * working" panel is populated from the store.
 *
 * Requires the full stack up (cockpit + worker + Inngest + Postgres), same as
 * the other phaseN tests. Runs fully mocked — no API keys needed.
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
const log = (m) => console.log(`[build4] ${m}`);

try {
  // 1) kick the meta-analysis engine from the Market intel page
  await page.goto(`${BASE}/market`);
  if (!(await page.locator("h1:has-text('Market intel')").count())) {
    throw new Error("Market intel page did not render");
  }
  await page.getByRole("button", { name: /Run market scan/ }).click();
  await page.waitForLoadState("networkidle");
  log("market scan kicked ✓");

  // 2) poll for patterns to land (worker ingests + analyses async)
  let populated = false;
  for (let i = 0; i < 40; i++) {
    await page.reload();
    const rising = await page.locator("h3:has-text('Rising angles')").count();
    const hooks = await page.locator("h3:has-text('Breakout hook patterns')").count();
    const seed = await page.getByRole("button", { name: /Seed idea/ }).count();
    if (rising && hooks && seed) {
      populated = true;
      break;
    }
    await page.waitForTimeout(3000);
  }
  if (!populated) throw new Error("market intel patterns did not populate after the scan");
  log("rising angles + hook patterns rendered ✓");

  // 3) scouted external videos are shown behind the patterns
  if (!(await page.locator("h3:has-text('Scouted videos')").count())) {
    throw new Error("scouted external videos panel missing");
  }
  await page.screenshot({ path: `${SHOTS}/build4-market.png`, fullPage: true });

  // 4) borrow a pattern → seed an idea
  await page.getByRole("button", { name: /Seed idea/ }).first().click();
  await page.waitForLoadState("networkidle");
  log("seeded an idea from a market pattern ✓");

  // 5) the channel "What's working" panel is populated from the store
  await page.goto(`${BASE}/channels`);
  await page.locator("table a").first().click();
  await page.waitForLoadState("networkidle");
  if (!(await page.locator("h3:has-text(\"What's working\")").count())) {
    throw new Error("channel What's-working panel missing");
  }
  if (!(await page.locator("text=Hook patterns").count())) {
    throw new Error("channel What's-working panel not populated with patterns");
  }
  await page.screenshot({ path: `${SHOTS}/build4-channel.png`, fullPage: true });

  log("OK — build #4 meta-analysis engine flow passed");
} finally {
  await browser.close();
}
