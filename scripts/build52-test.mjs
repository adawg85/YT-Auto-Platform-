/**
 * Build #5.2 E2E: review board + operator briefings + experiments, driven
 * through the real cockpit UI with zero API keys (mock providers).
 *
 *   wizard → aviation channel (T1, charter'd)
 *   → "Run check-in now" → briefing (what happened / direction / question
 *     / suggestions incl. ONE experiment proposal)
 *   → operator responds: agree + steer note → briefing acknowledged,
 *     experiment ACTIVE in the ledger
 *   → second check-in → no new experiment proposed while one is active
 *   → review board negative path: wizard channel in a niche whose ideas
 *     trip the charter's forbidden-topics list → script approved → the
 *     board holds the production ("review board: compliance…")
 *   → review board positive path: aviation idea flows past the board to
 *     the final gate (with the active experiment steering the draft)
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
const log = (m) => console.log(`[build5.2] ${m}`);
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

async function openTab(channelUrl, label) {
  await page.goto(channelUrl);
  await page.locator(".ptabs button", { hasText: label }).click();
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

/** run the setup wizard for a niche; returns the channel URL */
async function wizardChannel(niche, intent) {
  await page.goto(`${BASE}/channels/new`);
  await page.locator("input").first().fill(niche);
  await page.locator("input").nth(1).fill(intent);
  await page.getByRole("button", { name: /Draft charter with AI/ }).click();
  await page.locator("button.card").first().waitFor();
  await page.locator("button.card").first().click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Create channel" }).click();
  await page.locator("text=provision YouTube by hand").waitFor();
  const href = await page.locator('a[href^="/channels/"]').last().getAttribute("href");
  return `${BASE}${href}`;
}

/** ideas flow: generate → score → greenlight the first idea for a channel name */
async function greenlightFirstIdea(channelName) {
  await page.goto(`${BASE}/ideas`);
  await page.getByRole("button", { name: `✨ Generate ideas — ${channelName}` }).click();
  await page.waitForLoadState("networkidle");
  await page.goto(`${BASE}/ideas`);
  const row = page.locator("tbody tr", { hasText: channelName }).first();
  const title = (await row.locator("td").first().innerText()).split("\n")[0].trim();
  await row.getByRole("button", { name: "Score" }).click();
  await page.waitForLoadState("networkidle");
  await page.goto(`${BASE}/ideas`);
  await page
    .locator("tbody tr", { hasText: title })
    .first()
    .getByRole("button", { name: /Greenlight/ })
    .click();
  await page.waitForLoadState("networkidle");
  return title;
}

/** approve the pending script gate for an idea title; returns its production href */
async function approveScriptGate(title) {
  const card = await poll(`script gate for "${title}"`, 60, 2000, async () => {
    await page.goto(`${BASE}/gates`);
    const c = page.locator(".card", { hasText: title }).first();
    return (await c.count()) ? c : null;
  });
  const prodHref = await card.locator('a[href^="/productions/"]').first().getAttribute("href");
  await card.locator('input[placeholder*="notes"]').fill("build5.2 e2e");
  await card.getByRole("button", { name: "✓" }).click();
  return prodHref;
}

try {
  // ── 1) charter'd aviation channel via the wizard ──
  log("creating the aviation channel via the wizard…");
  const aviationUrl = await wizardChannel(
    "aviation history",
    "deeply researched evergreen stories, one machine per episode",
  );
  const aviationName = await (async () => {
    await page.goto(aviationUrl);
    return page.locator("h1").first().innerText();
  })();
  log(`aviation channel ready: ${aviationName} (${aviationUrl})`);

  // ── 2) briefing: run check-in now → body + suggestions render ──
  await openTab(aviationUrl, "Briefings");
  await page.getByRole("button", { name: /Run check-in now/ }).click();
  log("check-in kicked; waiting for the briefing…");
  await poll("first briefing", 40, 3000, async () => {
    await openTab(aviationUrl, "Briefings");
    return (await page.locator(".panel", { hasText: "What happened." }).count()) > 0;
  });
  const briefingPanel = page.locator(".panel", { hasText: "What happened." }).first();
  const briefingText = await briefingPanel.innerText();
  for (const section of ["What happened.", "Direction.", "Question."]) {
    if (!briefingText.includes(section)) throw new Error(`briefing missing "${section}"`);
  }
  if (!briefingText.includes("One variable:")) {
    throw new Error("briefing has no experiment suggestion (expected exactly one when idle)");
  }
  log("briefing rendered with direction + an experiment proposal ✓");
  await shot("b52-1-briefing-open");

  // ── 3) respond: agree to everything + a steer note → experiment ACTIVE ──
  const radios = briefingPanel.locator('input[value="agree"]');
  const n = await radios.count();
  for (let i = 0; i < n; i++) await radios.nth(i).check();
  await briefingPanel
    .locator('textarea[name="note"]')
    .fill("Agreed. Lean into early-jet-age stories next period.");
  await briefingPanel.getByRole("button", { name: "Send response" }).click();
  await poll("briefing acknowledged + experiment active", 20, 2000, async () => {
    await openTab(aviationUrl, "Briefings");
    const acked = (await page.locator(".badge", { hasText: "acknowledged" }).count()) > 0;
    const active =
      (await page
        .locator(".panel", { hasText: "Experiments" })
        .locator(".badge", { hasText: "active" })
        .count()) > 0;
    return acked && active;
  });
  log("operator response recorded; experiment is ACTIVE ✓");
  await shot("b52-2-briefing-answered");

  // ── 4) second check-in: no new experiment while one is active ──
  await openTab(aviationUrl, "Briefings");
  await page.getByRole("button", { name: /Run check-in now/ }).click();
  await poll("second briefing", 40, 3000, async () => {
    await openTab(aviationUrl, "Briefings");
    return (await page.locator(".panel", { hasText: "What happened." }).count()) >= 2;
  });
  const second = page.locator(".panel", { hasText: "What happened." }).first();
  if ((await second.innerText()).includes("One variable:")) {
    throw new Error("second briefing proposed an experiment while one is active");
  }
  log("second briefing respects one-variable-at-a-time ✓");

  // ── 5) review board NEGATIVE: forbidden-topic niche gets held ──
  // The mock charter forbids "financial advice"; mock ideation embeds the
  // niche in every title, and the mock script embeds the title — so this
  // channel's first idea deterministically trips the compliance checker.
  log("creating the forbidden-topic channel (board negative path)…");
  const riskyUrl = await wizardChannel("financial advice myths", "contrarian money takes");
  await page.goto(riskyUrl);
  const riskyName = await page.locator("h1").first().innerText();
  const riskyTitle = await greenlightFirstIdea(riskyName);
  log(`risky idea greenlit: "${riskyTitle}" — approving its script…`);
  const riskyProd = await approveScriptGate(riskyTitle);
  await poll("board holds the risky production", 90, 2000, async () => {
    await page.goto(`${BASE}${riskyProd}`);
    const text = await page.locator("body").innerText();
    return text.includes("review board") && text.includes("compliance");
  });
  log("review board held the production (compliance: forbidden topic) ✓");
  await shot("b52-3-board-held");

  // ── 6) review board POSITIVE: aviation idea passes to the final gate ──
  // (the ACTIVE experiment's directive steers this draft + tags the production)
  const cleanTitle = await greenlightFirstIdea(aviationName);
  log(`aviation idea greenlit: "${cleanTitle}" — approving its script…`);
  await approveScriptGate(cleanTitle);
  log("waiting for the board to pass + render + final gate…");
  await poll("final gate for the clean production", 240, 2000, async () => {
    await page.goto(`${BASE}/gates`);
    const row = page.locator("table.data tr", { hasText: cleanTitle }).first();
    return (await row.count()) > 0;
  });
  log("clean production passed the review board and reached the final gate ✓");
  await shot("b52-4-board-passed");

  log("OK — build #5.2 review board + briefings + experiments e2e passed");
} finally {
  await browser.close();
}
