/**
 * Phase 3 E2E: channel creation + DNA edit + T3 autonomy (no gates,
 * auto-publish) + release-to-public + OAuth error path.
 */
import { chromium } from "playwright";

const BASE = process.env.COCKPIT_URL ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? ".";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({
  httpCredentials: { username: "operator", password: "test-pass-123" },
  viewport: { width: 1400, height: 1100 },
});
page.setDefaultTimeout(30_000);
const log = (m) => console.log(`[phase3] ${m}`);

try {
  // 1) create a channel through the UI
  log("creating a T3 channel…");
  await page.goto(`${BASE}/channels/new`);
  await page.locator('input[name="name"]').fill("Deep Sea Facts");
  await page.locator('input[name="handle"]').fill("@deep-sea-facts");
  await page.locator('input[name="niche"]').fill("bizarre deep sea creatures");
  await page.locator('select[name="autonomyTier"]').selectOption("3");
  await page.getByRole("button", { name: "Create channel" }).click();
  await page.waitForURL((url) => /\/channels\/[0-9A-Z]{26}$/.test(url.pathname));
  const channelUrl = page.url();
  log(`channel created: ${channelUrl}`);
  await page.screenshot({ path: `${SHOTS}/p3-1-channel.png`, fullPage: true });

  // 2) edit DNA and save
  log("editing DNA…");
  await page.locator('input[name="tone"]').fill("ominous but playful");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.waitForLoadState("networkidle");
  await page.goto(channelUrl);
  const tone = await page.locator('input[name="tone"]').inputValue();
  if (tone !== "ominous but playful") throw new Error(`DNA edit not persisted: "${tone}"`);
  log("DNA edit persisted ✓");

  // 3) OAuth start without client id → friendly error banner
  const channelId = channelUrl.split("/").pop();
  await page.goto(`${BASE}/api/oauth/youtube/start?channelId=${channelId}`);
  await page.waitForURL(/error=/);
  if (!(await page.locator("text=Account page").count())) {
    throw new Error("expected OAuth-not-configured error banner");
  }
  log("OAuth error path ✓");

  // 4) generate ideas on the new channel and greenlight one — T3 must skip
  //    all gates and land on published automatically
  log("generating ideas…");
  await page.goto(`${BASE}/ideas`);
  await page.getByRole("button", { name: /Generate ideas — Deep Sea Facts/ }).click();
  await page.waitForLoadState("networkidle");
  await page.goto(`${BASE}/ideas`);
  const row = page.locator("tr", { hasText: "Deep Sea Facts" }).first();
  const ideaTitle = await row.locator("strong").first().innerText();
  log(`greenlighting (T3): ${ideaTitle}`);
  await row.getByRole("button", { name: /Greenlight/ }).click();
  await page.waitForLoadState("networkidle");

  log("waiting for T3 auto-publish (script → assets → render → publish, no gates)…");
  let prodUrl = null;
  for (let i = 0; i < 180; i++) {
    await page.goto(channelUrl);
    const prodRow = page.locator("tr", { hasText: ideaTitle }).first();
    if (await prodRow.count()) {
      const badge = await prodRow.locator(".badge").innerText();
      if (badge === "published") {
        prodUrl = await prodRow.locator("a").getAttribute("href");
        break;
      }
      if (["rejected", "failed", "on_hold", "script_review", "thumbnail_review"].includes(badge)) {
        throw new Error(`T3 production unexpectedly in state: ${badge}`);
      }
    }
    await page.waitForTimeout(2000);
  }
  if (!prodUrl) throw new Error("T3 production never published");
  log("T3 auto-published without gates ✓");

  // 5) release to public
  await page.goto(`${BASE}${prodUrl}`);
  await page.screenshot({ path: `${SHOTS}/p3-2-published-private.png`, fullPage: true });
  log("releasing to public…");
  await page.getByRole("button", { name: /Release to public/ }).click();
  let released = false;
  for (let i = 0; i < 30; i++) {
    await page.goto(`${BASE}${prodUrl}`);
    if (await page.locator(".badge.green", { hasText: "public" }).count()) { released = true; break; }
    await page.waitForTimeout(1000);
  }
  if (!released) throw new Error("publication did not flip to public");
  log("released to public ✓");
  await page.screenshot({ path: `${SHOTS}/p3-3-released.png`, fullPage: true });

  log("OK — phase 3 flows passed");
} finally {
  await browser.close();
}
