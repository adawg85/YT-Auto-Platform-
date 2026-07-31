/**
 * BUMP THIS whenever a change to the Remotion composition (ShortComposition /
 * Root / ShortProps) alters the RENDERED OUTPUT — a new layer (music bed, video
 * clips, captions…), new timing, or a changed prop shape.
 *
 * Why it exists: the Remotion **Lambda** renderer renders from a site bundle
 * that is deployed SEPARATELY from the worker (S3 `sites/ytauto`, a fixed
 * REMOTION_SERVE_URL) and does NOT refresh on a normal push. On 2026-07-18 that
 * bundle was found to be 7 days stale — it predated both clip compositing
 * (2026-07-12) and the music bed (2026-07-16) — so every Lambda render was a
 * SILENT, clip-less slideshow while the worker (correctly) stamped metadata
 * claiming clips+music were present. Nothing caught it.
 *
 * The worker's render step compares the deployed bundle's timestamp against this
 * value and REFUSES to render on a bundle older than it (fail-loud, not
 * fail-silent). Set it to the moment of the output-affecting change. After
 * bumping, redeploy the site so the bundle catches up:
 *   pnpm --filter @ytauto/worker exec tsx scripts/remotion-lambda-deploy.ts
 * (the worker preDeploy also redeploys it on push).
 */
// 2026-07-30 bump: #79 caption legibility changed the RENDERED caption output —
// the default is now white text with a heavy dark outline + strong shadow (was
// white with only a soft shadow, invisible over bright frames), plus configurable
// color/outlineColor/outlineWidth/shadow/scrim. Without this bump the Lambda site
// bundle (deployed separately, does NOT refresh on push) keeps rendering the old
// low-contrast captions while the worker stamps the fix as applied. Bumping forces
// the fail-loud guard to REFUSE a stale bundle until the site is redeployed (CI
// deploy-lambda-site runs on push to packages/video; manual: pnpm lambda:deploy).
// 2026-07-31 bump: #79 follow-up — the paint fields weren't reaching the render.
// The active (spoken) word was forced to the brand accent, overriding a configured
// `color` (white captions rendered blue), and the outline/shadow lived only on the
// container so the color-overriding word spans dropped them (thin/absent). Now the
// active word uses the base color (opt into a highlight via the new `activeColor`)
// and outline+shadow are applied PER WORD. Requires a fresh Lambda site bundle, or
// the stale one keeps rendering blue captions while the worker stamps the fix.
// (Prior 2026-07-28 bump: #72 caption styling + #73 Ken-Burns/dissolve + quote cards.)
export const COMPOSITION_BUNDLE_MIN_DATE = "2026-07-31T00:00:00Z";
