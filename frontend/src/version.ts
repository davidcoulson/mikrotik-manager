export const APP_VERSION = 'v1.0.0 RC 9';

/**
 * Commit and date of a non-release build ("a1b2c3d · 2026-10-15"), or '' for a
 * release build, which passes no build info. Shown under the version so a test
 * image can be told apart from the release it was cut from.
 */
export const BUILD_LABEL: string = (() => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  const sha = String(env.VITE_BUILD_SHA ?? '').slice(0, 7);
  const date = String(env.VITE_BUILD_DATE ?? '');
  return [sha, date].filter(Boolean).join(' · ');
})();

/**
 * Documentation for *this* build.
 *
 * The site is published per release series with mike, so a reader running
 * 0.24.x gets pages describing 0.24.x rather than whatever is newest. Deriving
 * the series from APP_VERSION keeps the in-app link honest as the product moves
 * on; falling back to `latest` covers a development build whose series has not
 * been published yet.
 */
const DOCS_BASE = 'https://2gt-media-group-llc.github.io/mikrotik-manager';

export function docsUrl(path = ''): string {
  const series = /v?(\d+\.\d+)/.exec(APP_VERSION)?.[1];
  const suffix = path.replace(/^\//, '');
  return `${DOCS_BASE}/${series ?? 'latest'}/${suffix}`;
}
