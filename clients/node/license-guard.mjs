// In-process license guard — reference client for Node / Next.js services.
//
// Verifies the license *inside the application process*, using the same algorithm, the same
// signed license file, and the same public key as the sidecar gate. Unlike the gate, this
// cannot be skipped by running the container directly — the app itself refuses to serve.
//
// Integrate by wrapping a route handler (one line):
//     import { withLicense } from '../../../lib/license-guard.mjs';
//     export const GET = withLicense(async (req) => Response.json({ ... }));
//
// Inputs (same as the gate), via env with sensible defaults:
//     LICENSE_PUBLIC_KEY_PATH   baked-in vendor public key   (default /app/public.pem)
//     LICENSE_FILE              shared, imported license     (default /data/license.lic)
//     LICENSE_MACHINE_ID_PATH   mounted host machine-id      (default /host/machine-id)
//
// Fail-closed: a wrapped handler answers 403 while the license is missing/invalid/expired.
// Runs in the Node runtime (uses node:crypto + node:fs), not the Edge runtime. For real
// distribution, publish as an internal npm package (and ideally obfuscate/compile the check).
import crypto from 'node:crypto';
import fs from 'node:fs';

const PUBLIC_KEY_PATH = process.env.LICENSE_PUBLIC_KEY_PATH || '/app/public.pem';
const LICENSE_FILE = process.env.LICENSE_FILE || '/data/license.lic';
const MACHINE_ID_PATH = process.env.LICENSE_MACHINE_ID_PATH || '/host/machine-id';
const DAY = 86_400_000;

let _pub;
const publicKey = () => (_pub ??= crypto.createPublicKey(fs.readFileSync(PUBLIC_KEY_PATH)));

let _fp;
function fingerprint() {
  if (_fp !== undefined) return _fp;
  try {
    const id = fs.readFileSync(MACHINE_ID_PATH, 'utf8').trim();
    _fp = id
      ? crypto.createHash('sha256').update(`amh-license-v1:${id}`).digest('hex').slice(0, 32).toUpperCase().match(/.{4}/g).join('-')
      : null;
  } catch {
    _fp = null;
  }
  return _fp;
}

let cache = { mtime: -1, claims: null };
function loadClaims() {
  let st;
  try {
    st = fs.statSync(LICENSE_FILE);
  } catch {
    cache = { mtime: -1, claims: null };
    return null;
  }
  if (st.mtimeMs === cache.mtime) return cache.claims;
  let claims = null;
  try {
    const { payload, signature } = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
    if (crypto.verify(null, Buffer.from(payload), publicKey(), Buffer.from(signature, 'base64'))) {
      claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    }
  } catch {
    claims = null;
  }
  cache = { mtime: st.mtimeMs, claims };
  return claims;
}

export function getLicenseStatus(now = Date.now()) {
  const c = loadClaims();
  if (!c) return { valid: false, code: 'NO_LICENSE', message: 'No valid license installed' };
  if (c.fingerprint !== fingerprint()) return { valid: false, code: 'MACHINE_MISMATCH', message: 'License issued for a different machine' };
  const exp = Date.parse(c.expiresAt);
  const graceEnd = exp + (c.graceDays || 0) * DAY;
  if (now > graceEnd) return { valid: false, code: 'EXPIRED', message: 'License has expired', expiresAt: c.expiresAt };
  if (now > exp) return { valid: true, code: 'GRACE', message: 'License in grace period', expiresAt: c.expiresAt };
  return { valid: true, code: 'VALID', message: 'License valid', expiresAt: c.expiresAt };
}

/** Wrap a Next.js (or any Web-API) route handler so it refuses to serve without a valid license. */
export function withLicense(handler) {
  return async (req, ctx) => {
    const s = getLicenseStatus();
    if (!s.valid) {
      return Response.json({ error: 'LICENSE_INVALID', code: s.code, message: s.message }, { status: 403 });
    }
    const res = await handler(req, ctx);
    try {
      res.headers.set('x-license-status', s.code);
    } catch {
      /* some Response objects have immutable headers; ignore */
    }
    return res;
  };
}
