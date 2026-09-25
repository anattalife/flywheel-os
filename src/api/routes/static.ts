import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../../lib/http.js';
import { router } from '../context.js';

export const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web');
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};
export const APP_CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const cache = new Map<string, Buffer>();
export async function webFile(rel: string): Promise<Buffer> {
  const full = path.resolve(WEB_DIR, rel);
  if (!full.startsWith(WEB_DIR + path.sep)) throw new HttpError(404, 'not found');
  if (process.env.NODE_ENV === 'production' && cache.has(full)) return cache.get(full)!;
  try {
    const buf = await readFile(full);
    cache.set(full, buf);
    return buf;
  } catch {
    throw new HttpError(404, 'not found');
  }
}

const appShell = async () => ({
  text: await webFile('owner/index.html'), contentType: TYPES['.html'],
  headers: { 'content-security-policy': APP_CSP, 'cache-control': 'no-cache' },
});

/** The owner app is a single page; every /app path returns the same shell. */
router.add('GET', '/app', appShell);
router.add('GET', '/app/:a', appShell);
router.add('GET', '/app/:a/:b', appShell);

router.add('GET', '/assets/:area/:file', async (req) => {
  const { area, file } = req.params;
  if (!/^(owner|site|shared)$/.test(area) || !/^[\w.-]+$/.test(file)) throw new HttpError(404, 'not found');
  const ext = path.extname(file);
  return {
    text: await webFile(`${area}/${file}`), contentType: TYPES[ext] ?? 'application/octet-stream',
    headers: { 'cache-control': process.env.NODE_ENV === 'production' ? 'public, max-age=300' : 'no-cache' },
  };
});

router.add('GET', '/', async () => ({ status: 302, text: '', headers: { location: '/app' } }));
