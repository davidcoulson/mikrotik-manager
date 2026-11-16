import type { Request } from 'express';

/**
 * The request path with each segment decoded, as Express decodes route
 * parameters (GHSA-6xq3-q9m5-7hxp). Access checks that read an id from the
 * path must see the same value the route handler will, or a differently
 * spelled path could be checked as one thing and handled as another.
 * Returns null for a segment that can't be decoded, which callers refuse.
 *
 * Lower-cased and without a trailing slash, because Express routes
 * `/ROLLOUTS/42/start` and `/channel/` to the same handlers as the plain
 * spellings; a check that only knew the plain one let the others through.
 */
export function decodedPath(req: Pick<Request, 'path'>): string | null {
  try {
    const p = req.path.split('/').map((seg) => decodeURIComponent(seg)).join('/').toLowerCase();
    return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
  } catch {
    return null;
  }
}
