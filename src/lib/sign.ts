import { createHmac } from 'node:crypto';
import { config } from '../config.js';
import { safeEqual } from './secrets.js';

/** A short signature so links like /pay/<id>?t=<sig> can't be guessed or altered. */
export function sign(kind: string, id: string): string {
  return createHmac('sha256', config().APP_SECRET).update(`${kind}:${id}`).digest('base64url').slice(0, 24);
}
export function verifySig(kind: string, id: string, sig: string | null | undefined): boolean {
  return !!sig && safeEqual(sign(kind, id), sig);
}
