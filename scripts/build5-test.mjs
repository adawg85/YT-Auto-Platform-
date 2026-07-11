/**
 * Build #5 E2E: the editorial engine, driven through the real cockpit UI with
 * zero API keys (mock providers).
 *
 *   wizard (charter + AI identity) → aviation channel (T1)
 *   → editorial planner (proposed series → operator approves)
 *   → episode research (sources → memory → claims → tiered verification)
 *   → idea handoff → pipeline factuality gate → script gate WITH citations
 *   → render → final gate → publish → post-publish coverage carry-over
 *   → regression: the charter-less physics channel skips the factuality gate.
 *
 * Requires the full stack up (cockpit + worker + Inngest + pgvector Postgres).
 */
import { chromium } from "playwright";

const BASE = process.env.COCKPIT_URL ?? "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? ".";
const browser = await chromium.launch(
  process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {},
);
const page = await browser.newPage({
  httpCredentials: { username: "operator", password: "test-pass-123" },
  viewport: { width: 1400, height: 1100 },
});
page.setDefaultTimeout(45_000);
const log = (m) => console.log(`[build5] ${m}`);
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

async function openPlanTab(channelUrl) {
  await page.goto(channelUrl);
  await page.locator(".ptabs button", { hasText: "Plan" }).click();
}

/** poll fn() every intervalMs until it returns truthy (or attempts run out) */
async function poll(label, attempts, intervalMs, fn) {
  for (let i = 0; i < attempts; i++) {
    const out = await fn();
    if (out) return out;
    await page.waitForTimeout(intervalMs);
  }
  throw new Error(`timed out: ${label}`);
}

try {
  // ── 1) setup wizard: charter + AI identity → create the aviation channel ──
  log("running the setup wizard…");
  await page.goto(`${BASE}/channels/new`);
  await page.locator("input").first().fill("aviation history");
  await page
    .locator("input")
    .nth(1)
    .fill("deeply researched evergreen stories, one machine per episode");
  await page.getByRole("button", { name: /Draft charter with AI/ }).click();

  await page.locator("button.idcard").first().waitFor();
  const identityName = await page.locator("button.idcard .nm").first().innerText();
  log(`AI identities proposed; picking "${identityName}"`);
  await page.locator("button.idcard").first().click();
  await page.getByRole("button", { name: "Continue" }).click();
  await shot("b5-1-wizard-review");

  // review step: charter fields are pre-filled; keep T1 (human gates ON)
  const mission = await page.locator("textarea").first().inputValue();
  if (!mission.includes("aviation history")) throw new Error("charter mission not pre-filled");
  await page.getByRole("button", { name: "Create channel" }).click();
  await page.locator("text=The engine plans + researches while you provision").waitFor();
  const channelHref = await page.locator('a[href^="/channels/"]').last().getAttribute("href");
  const channelUrl = `${BASE}${channelHref}`;
  log(`channel created with charter: ${channelHref} ✓`);
  await shot("b5-2-provisioning-card");

  // ── 2) editorial planner: kick, approve the proposed arc ──
  await openPlanTab(channelUrl);
  await page.getByRole("button", { name: /Plan \/ research now/ }).click();
  log("planner kicked; waiting for the proposed series…");
  await poll("proposed series", 40, 3000, async () => {
    await openPlanTab(channelUrl);
    return (await page.getByRole("button", { name: "Approve" }).count()) > 0;
  });
  await shot("b5-3-proposed-series");
  const episodeTitle = (await page.locator(".eprow .linklike:visible").first().innerText())
    .replace(/^\d+\s*/, "")
    .split("\n")[0]
    .trim();
  log(`series proposed (episode 1: "${episodeTitle}"); approving…`);
  await page.getByRole("button", { name: "Approve" }).click();

  // ── 3) episode research: sources → claims → tiered verification → queued ──
  log("waiting for episode research (fetch → memory → claims → verify → brief)…");
  await poll("episode research", 60, 3000, async () => {
    await openPlanTab(channelUrl);
    const row = page.locator(".eprow:visible", { hasText: episodeTitle }).first();
    if (!(await row.count())) return false;
    return (await row.locator(".badge", { hasText: "Ready to produce" }).count()) > 0;
  });
  const epRow = page.locator(".eprow:visible", { hasText: episodeTitle }).first();
  const rowText = await epRow.innerText();
  if (!/✓\d+/.test(rowText)) throw new Error(`no verified claims on the episode row: ${rowText}`);
  // corroboration default is 1 since #20 — nothing is cut on the happy path;
  // a ✗ pill is a bonus (deep-rigor channels), not an assertion.
  log(`episode researched: verified claims present ✓ (${rowText.replace(/\s+/g, " ").slice(0, 100)})`);
  await shot("b5-4-episode-researched");

  // ── 4) idea handoff: auto-scored at handoff (#18) → inline Greenlight on the Plan row ──
  await openPlanTab(channelUrl);
  await page
    .locator(".eprow:visible", { hasText: episodeTitle })
    .first()
    .getByRole("button", { name: /Greenlight/ })
    .click();
  await page.waitForTimeout(1500); // networkidle never settles: /api/live long-poll
  log("editorial idea greenlit → pipeline (factuality gate → script)…");

  // ── 5) script gate carries citations ──
  const aviationCard = await poll("script gate with citations", 60, 2000, async () => {
    await page.goto(`${BASE}/gates`);
    const card = page.locator(".card", { hasText: episodeTitle }).first();
    return (await card.count()) ? card : null;
  });
  const cardText = await aviationCard.innerText();
  if (!/sources — \d+ verified/.test(cardText)) {
    throw new Error(`script gate has no citations section:\n${cardText.slice(0, 400)}`);
  }
  log("script gate shows verified sources ✓");
  await aviationCard.locator("details", { hasText: "sources" }).locator("summary").click();
  await shot("b5-5-gate-citations");
  await aviationCard.locator('input[placeholder*="Notes"]').fill("Citations check out.");
  await aviationCard.getByRole("button", { name: /Approve/ }).click();
  log("script approved; waiting for render + final gate (includes the Remotion render)…");

  // ── 6) render → thumbnail review → final review → scheduled (#20 publishAt) ──
  // Approval uploads immediately; a gated T1 channel auto-slots the release onto
  // the warm-up ramp (goes public via the finalize cron at slot time). Approve
  // every remaining gate on the production page until the publication chip
  // shows scheduled/published.
  const prodHref = await poll("post-render gate", 240, 2000, async () => {
    await page.goto(`${BASE}/gates`);
    const row = page.locator("table.data tr", { hasText: episodeTitle }).first();
    if (!(await row.count())) return false;
    return row.locator("a.btn").getAttribute("href");
  });
  await poll("scheduled or published", 90, 3000, async () => {
    await page.goto(`${BASE}${prodHref}`);
    const body = await page.locator("body").innerText();
    // publication exists → the #20 publish-controls / status copy is on the page
    if (/goes public automatically|Publish now|Move schedule|Live on YouTube/i.test(body)) return true;
    const notes = page.getByPlaceholder(/worth recording|notes/i).first();
    if (await notes.count()) await notes.fill("LGTM — ship it.").catch(() => {});
    const approve = page.getByRole("button", { name: /Approve/ }).first();
    if (!(await approve.count())) return false;
    await approve.click().catch(() => {});
    await page.waitForTimeout(1200);
    return false;
  });
  log("production uploaded + release scheduled (publishAt flow) ✓");
  await shot("b5-6-scheduled");

  // ── 8) regression: charter-less physics channel skips the factuality gate ──
  log("regression: greenlighting a physics idea (no charter → gate must skip)…");
  await page.goto(`${BASE}/ideas`);
  const physicsRow = page.locator("tr", { hasText: "Mpemba" }).first();
  if (!(await physicsRow.count())) throw new Error("seeded physics idea missing (run pnpm db:seed)");
  if (await physicsRow.getByRole("button", { name: "Score" }).count()) {
    await physicsRow.getByRole("button", { name: "Score" }).click();
    await page.waitForTimeout(1500); // networkidle never settles: /api/live long-poll
    await page.goto(`${BASE}/ideas`);
  }
  const glBtn = page
    .locator("tr", { hasText: "Mpemba" })
    .first()
    .getByRole("button", { name: /Greenlight/ });
  if (await glBtn.count()) {
    await glBtn.click();
    await page.waitForTimeout(1500); // networkidle never settles: /api/live long-poll
  } else {
    log("physics idea already greenlit (prior run) — reusing its pending gate");
  }

  const physicsCard = await poll("physics script gate", 60, 2000, async () => {
    await page.goto(`${BASE}/gates`);
    const card = page.locator(".card", { hasText: "Mpemba" }).first();
    return (await card.count()) ? card : null;
  });
  const physicsText = await physicsCard.innerText();
  if (/sources — \d+ verified/.test(physicsText)) {
    throw new Error("physics gate unexpectedly carries citations — factuality gate did not skip");
  }
  log("physics channel reached its script gate with no citations (gate skipped) ✓");
  // stop the regression production here — reject the draft
  await physicsCard.locator('input[placeholder*="Notes"]').fill("e2e regression check only.");
  await physicsCard.getByRole("button", { name: /Reject/ }).click();
  await shot("b5-7-physics-regression");

  log("OK — build #5 editorial engine e2e passed");
} finally {
  await browser.close();
}
