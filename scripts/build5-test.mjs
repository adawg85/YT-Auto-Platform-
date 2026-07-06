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

  await page.locator("button.card").first().waitFor();
  const identityName = await page.locator("button.card strong").first().innerText();
  log(`AI identities proposed; picking "${identityName}"`);
  await page.locator("button.card").first().click();
  await page.getByRole("button", { name: "Continue" }).click();
  await shot("b5-1-wizard-review");

  // review step: charter fields are pre-filled; keep T1 (human gates ON)
  const mission = await page.locator("textarea").first().inputValue();
  if (!mission.includes("aviation history")) throw new Error("charter mission not pre-filled");
  await page.getByRole("button", { name: "Create channel" }).click();
  await page.locator("text=provision YouTube by hand").waitFor();
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
  const episodeTitle = (await page.locator(".panel table tbody tr td:nth-child(2)").first().innerText())
    .split("\n")[0]
    .trim();
  log(`series proposed (episode 1: "${episodeTitle}"); approving…`);
  await page.getByRole("button", { name: "Approve" }).click();

  // ── 3) episode research: sources → claims → tiered verification → queued ──
  log("waiting for episode research (fetch → memory → claims → verify → brief)…");
  await poll("episode research", 60, 3000, async () => {
    await openPlanTab(channelUrl);
    const row = page.locator(".panel table tbody tr", { hasText: episodeTitle }).first();
    if (!(await row.count())) return false;
    return (await row.locator(".badge", { hasText: "queued" }).count()) > 0;
  });
  const epRow = page.locator(".panel table tbody tr", { hasText: episodeTitle }).first();
  const rowText = await epRow.innerText();
  if (!/\d+✓/.test(rowText)) throw new Error(`no verified claims on the episode row: ${rowText}`);
  if (!/\d+✗/.test(rowText)) throw new Error("expected the single-domain fact to be CUT (✗ badge)");
  log(`episode researched: verified + cut claims present ✓ (${rowText.replace(/\s+/g, " ").slice(0, 100)})`);
  await shot("b5-4-episode-researched");

  // ── 4) idea handoff → greenlight (T1: human gate stays on) ──
  await page.goto(`${BASE}/ideas`);
  const ideaRow = page.locator("tr", { hasText: episodeTitle }).first();
  if (!(await ideaRow.count())) throw new Error("editorial idea not in the inbox");
  await ideaRow.getByRole("button", { name: "Score" }).click();
  await page.waitForLoadState("networkidle");
  await page.goto(`${BASE}/ideas`);
  await page
    .locator("tr", { hasText: episodeTitle })
    .first()
    .getByRole("button", { name: /Greenlight/ })
    .click();
  await page.waitForLoadState("networkidle");
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
  await aviationCard.locator('input[placeholder*="notes"]').fill("Citations check out.");
  await aviationCard.getByRole("button", { name: "✓" }).click();
  log("script approved; waiting for render + final gate (includes the Remotion render)…");

  // ── 6) final gate → publish ──
  const prodHref = await poll("final gate", 240, 2000, async () => {
    await page.goto(`${BASE}/gates`);
    const row = page.locator("table.data tr", { hasText: episodeTitle }).first();
    if (!(await row.count())) return false;
    return row.locator("a.btn").getAttribute("href");
  });
  await page.goto(`${BASE}${prodHref}`);
  await page.getByPlaceholder(/Editorial notes/).fill("Render looks good. Ship it.");
  await page.getByRole("button", { name: /Approve/ }).click();
  log("final gate approved; waiting for publication + coverage carry-over…");

  // ── 7) post-publish: episode published + coverage summary carried over ──
  await poll("published episode with coverage", 90, 2000, async () => {
    await openPlanTab(channelUrl);
    const row = page.locator(".panel table tbody tr", { hasText: episodeTitle }).first();
    if (!(await row.count())) return false;
    if (!(await row.locator(".badge", { hasText: "published" }).count())) return false;
    const coverage = await row.locator("td").last().innerText();
    return coverage.trim().length > 0;
  });
  log("episode published; coverage summary carried into channel memory ✓");
  await shot("b5-6-published-coverage");

  // ── 8) regression: charter-less physics channel skips the factuality gate ──
  log("regression: greenlighting a physics idea (no charter → gate must skip)…");
  await page.goto(`${BASE}/ideas`);
  const physicsRow = page.locator("tr", { hasText: "Mpemba" }).first();
  if (!(await physicsRow.count())) throw new Error("seeded physics idea missing (run pnpm db:seed)");
  if (await physicsRow.getByRole("button", { name: "Score" }).count()) {
    await physicsRow.getByRole("button", { name: "Score" }).click();
    await page.waitForLoadState("networkidle");
    await page.goto(`${BASE}/ideas`);
  }
  await page
    .locator("tr", { hasText: "Mpemba" })
    .first()
    .getByRole("button", { name: /Greenlight/ })
    .click();
  await page.waitForLoadState("networkidle");

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
  await physicsCard.locator('input[placeholder*="notes"]').fill("e2e regression check only.");
  await physicsCard.getByRole("button", { name: "✕" }).click();
  await shot("b5-7-physics-regression");

  log("OK — build #5 editorial engine e2e passed");
} finally {
  await browser.close();
}
