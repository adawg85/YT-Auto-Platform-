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
export const COMPOSITION_BUNDLE_MIN_DATE = "2026-07-16T00:00:00Z";
