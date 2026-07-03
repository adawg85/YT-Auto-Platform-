/** E2E test of the /account encrypted-keys page. */
import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? ".";
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({
  httpCredentials: { username: "operator", password: "test-pass-123" },
  viewport: { width: 1400, height: 1100 },
});
page.setDefaultTimeout(30_000);
const log = (m) => console.log(`[account-test] ${m}`);

try {
  await page.goto(`${BASE}/account`);
  await page.screenshot({ path: `${SHOTS}/account-1-initial.png`, fullPage: true });

  // adapter should start as mock
  if (!(await page.locator("text=LLM:").locator("..").innerText()).includes("mock")) {
    throw new Error("expected LLM adapter to start as mock");
  }

  log("saving a fake OpenRouter key…");
  const row = page.locator("tr", { hasText: "OPENROUTER_API_KEY" });
  await row.locator('input[type="password"]').fill("sk-or-v1-test-key-abc9");
  await row.getByRole("button", { name: "Save" }).click();
  await page.waitForLoadState("networkidle");
  await page.goto(`${BASE}/account`);

  const rowText = await page.locator("tr", { hasText: "OPENROUTER_API_KEY" }).innerText();
  if (!rowText.includes("set") || !rowText.includes("abc9")) {
    throw new Error(`expected key marked set with last4 'abc9', got: ${rowText}`);
  }
  log("key saved, last4 shown ✓");

  const adapters = await page.locator(".card", { hasText: "Active adapters" }).innerText();
  if (!adapters.includes("openrouter")) {
    throw new Error(`expected LLM adapter to flip to openrouter, got: ${adapters}`);
  }
  log("LLM adapter flipped to real (openrouter) ✓");
  await page.screenshot({ path: `${SHOTS}/account-2-saved.png`, fullPage: true });

  log("clearing the key…");
  await page.locator("tr", { hasText: "OPENROUTER_API_KEY" }).getByRole("button", { name: "Clear" }).click();
  await page.waitForLoadState("networkidle");
  await page.goto(`${BASE}/account`);
  const cleared = await page.locator("tr", { hasText: "OPENROUTER_API_KEY" }).innerText();
  if (!cleared.includes("not set")) throw new Error("expected key cleared");
  const adapters2 = await page.locator(".card", { hasText: "Active adapters" }).innerText();
  if (!adapters2.includes("mock-llm")) throw new Error("expected LLM back to mock after clear");
  log("cleared, adapter back to mock ✓");

  log("OK");
} finally {
  await browser.close();
}
