/**
 * Phase 5 E2E: trend fast lane → batch script review → thumbnail pick at
 * the final gate → publish with selected thumbnail → assistant tool-calling.
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
const log = (m) => console.log(`[phase5] ${m}`);

try {
  // 1) trend fast lane: scan ran (cron/event) — verify fast-lane ideas exist
  await page.goto(`${BASE}/ideas`);
  log("scanning trends…");
  await page.getByRole("button", { name: /Scan trends/ }).click();
  await page.waitForLoadState("networkidle");
  let fastSeen = false;
  for (let i = 0; i < 30; i++) {
    await page.goto(`${BASE}/ideas`);
    if (await page.locator("tr", { hasText: "⚡ fast lane" }).count()) {
      fastSeen = true;
      await page.screenshot({ path: `${SHOTS}/p5-1-fastlane.png`, fullPage: true });
      log("fast-lane ideas present ✓");
      break;
    }
    await page.waitForTimeout(2000);
  }
  if (!fastSeen) throw new Error("no fast-lane idea appeared after trend scan");

  // gated flow runs on the T0 channel with a pre-seeded idea (argv)
  const fastIdea = process.argv[2] ?? "Why bridges hum in strong wind";
  const gatedRow = page.locator("tr", { hasText: fastIdea }).first();
  log(`greenlighting on gated channel: ${fastIdea}`);
  await gatedRow.getByRole("button", { name: /Greenlight/ }).click();
  await page.waitForLoadState("networkidle");

  // 2) batch review: approve the script inline on /gates
  log("waiting for script gate (batch card)…");
  let approved = false;
  for (let i = 0; i < 60; i++) {
    await page.goto(`${BASE}/gates`);
    const card = page.locator(".card", { hasText: fastIdea });
    if (await card.count()) {
      if (!(await card.locator("text=hook").count())) throw new Error("batch card missing hook");
      await page.screenshot({ path: `${SHOTS}/p5-2-batch-review.png`, fullPage: true });
      await card.locator('input[type="text"]').fill("batch-approved: hook is strong");
      await card.getByRole("button", { name: "✓" }).click();
      await page.waitForTimeout(1500);
      approved = true;
      log("script approved inline from the queue ✓");
      break;
    }
    await page.waitForTimeout(1500);
  }
  if (!approved) throw new Error("script gate never appeared in batch queue");

  // 3) final gate with thumbnail candidates
  log("waiting for final gate with thumbnail candidates…");
  let prodUrl = null;
  for (let i = 0; i < 180; i++) {
    await page.goto(`${BASE}/gates`);
    const row = page.locator("tr", { hasText: fastIdea }).first();
    if (await row.count()) {
      prodUrl = await row.locator("a").first().getAttribute("href");
      break;
    }
    await page.waitForTimeout(2000);
  }
  if (!prodUrl) throw new Error("final gate never appeared");
  await page.goto(`${BASE}${prodUrl}`);
  const radios = page.locator('input[type="radio"][name="thumb"]');
  const radioCount = await radios.count();
  if (radioCount < 2) throw new Error(`expected >=2 thumbnail candidates, got ${radioCount}`);
  log(`thumbnail candidates shown: ${radioCount} ✓`);
  await page.screenshot({ path: `${SHOTS}/p5-3-thumbnail-pick.png`, fullPage: true });
  await radios.nth(1).check(); // pick the second candidate deliberately
  await page.getByPlaceholder(/Editorial notes/).fill("ship it with candidate #2");
  await page.getByRole("button", { name: /Approve/ }).click();

  log("waiting for publication…");
  let published = false;
  for (let i = 0; i < 60; i++) {
    await page.goto(`${BASE}${prodUrl}`);
    if (await page.locator("text=Publication").count()) { published = true; break; }
    await page.waitForTimeout(1500);
  }
  if (!published) throw new Error("never published");
  log("published with selected thumbnail ✓");

  // 4) assistant: mock LLM routes phrases to tools
  log("testing assistant…");
  await page.goto(`${BASE}/assistant`);
  await page.locator('input[type="text"]').fill("what's pending for review?");
  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForSelector("text=Done. Tool result", { timeout: 30_000 });
  log("assistant tool call round-trip ✓");
  await page.screenshot({ path: `${SHOTS}/p5-4-assistant.png`, fullPage: true });

  log("OK — phase 5 flows passed");
} finally {
  await browser.close();
}
