/**
 * Vertical-slice acceptance run, driven through the real cockpit UI:
 * greenlight a seeded idea → approve script gate → wait for render →
 * approve final gate → verify publication.
 */
import { chromium } from "playwright";

const BASE = process.env.COCKPIT_URL ?? "http://localhost:3000";
const IDEA = process.argv[2] ?? "Why airplane windows are round";
const AUTH = { username: "operator", password: "test-pass-123" };
const shot = (p, name) => p.screenshot({ path: `${process.env.SHOTS ?? "."}/${name}.png`, fullPage: true });

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({ httpCredentials: AUTH, viewport: { width: 1400, height: 1000 } });
page.setDefaultTimeout(30_000);

const log = (m) => console.log(`[acceptance] ${m}`);

try {
  // 1) Ideas backlog: score + greenlight the first seeded idea
  await page.goto(`${BASE}/ideas`);
  await shot(page, "01-ideas");
  const ideaRow = page.locator("tr", { hasText: IDEA }).first();

  log("scoring idea…");
  await ideaRow.getByRole("button", { name: "Score" }).click();
  await page.waitForLoadState("networkidle");
  await shot(page, "02-ideas-scored");

  log("greenlighting idea…");
  await ideaRow.getByRole("button", { name: /Greenlight/ }).click();
  await page.waitForLoadState("networkidle");

  // 2) Gate queue: wait for the script gate to appear
  log("waiting for script gate…");
  let reviewHref = null;
  for (let i = 0; i < 60; i++) {
    await page.goto(`${BASE}/gates`);
    const link = page.locator('a.btn:has-text("Review")').first();
    if (await link.count()) {
      reviewHref = await link.getAttribute("href");
      break;
    }
    await page.waitForTimeout(1000);
  }
  if (!reviewHref) throw new Error("script gate never appeared");
  await shot(page, "03-gates-script");

  // 3) Production page: approve the script
  await page.goto(`${BASE}${reviewHref}`);
  await shot(page, "04-production-script-review");
  log("approving script…");
  await page.getByPlaceholder(/Editorial notes/).fill("Hook is strong, facts check out. Approved.");
  await page.getByRole("button", { name: /Approve/ }).click();
  await page.waitForLoadState("networkidle");

  // 4) Wait for assets + render + final gate (pipeline does TTS, images, variation check, render)
  log("waiting for render + final gate (this includes the Remotion render)…");
  let finalGate = false;
  for (let i = 0; i < 180; i++) {
    await page.goto(`${BASE}${reviewHref}`);
    if (await page.locator("text=Final review — decision required").count()) {
      finalGate = true;
      break;
    }
    if (await page.locator(".badge.red").count()) {
      const body = await page.locator("body").innerText();
      throw new Error(`production failed/rejected:\n${body.slice(0, 800)}`);
    }
    await page.waitForTimeout(2000);
  }
  if (!finalGate) throw new Error("final gate never appeared (render may have failed — check worker log)");
  await shot(page, "05-final-review-with-video");

  // 5) Approve final gate → publish
  log("approving final gate…");
  await page.getByPlaceholder(/Editorial notes/).fill("Render looks good. Ship it (private).");
  await page.getByRole("button", { name: /Approve/ }).click();

  log("waiting for publication…");
  let published = false;
  for (let i = 0; i < 60; i++) {
    await page.goto(`${BASE}${reviewHref}`);
    if (await page.locator("text=Publication").count()) {
      published = true;
      break;
    }
    await page.waitForTimeout(1000);
  }
  if (!published) throw new Error("publication never appeared");
  await shot(page, "06-published");

  // 6) Cost page
  await page.goto(`${BASE}/costs`);
  await shot(page, "07-costs");

  log("OK — full slice passed");
} finally {
  await browser.close();
}
