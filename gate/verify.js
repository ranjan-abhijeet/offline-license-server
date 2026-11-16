// Self-contained license verification for the sidecar gate.
// Same algorithm as license-service, but read-only: it never writes state and does not
// depend on license-service being up. The public key is baked into the gate image.
const crypto = require('node:crypto');
const fs = require('node:fs');

const PUBLIC_KEY_PATH = process.env.PUBLIC_KEY_PATH || '/app/public.pem';
const LICENSE_FILE = process.env.LICENSE_FILE || '/data/license.lic';
const MACHINE_ID_PATH = process.env.MACHINE_ID_PATH || '/host/machine-id';
const DAY = 86_400_000;

let _publicKey;
const publicKey = () => (_publicKey ??= crypto.createPublicKey(fs.readFileSync(PUBLIC_KEY_PATH)));

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

// Re-read + re-verify only when the license file changes (cheap stat on the hot path).
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
    claims = null; // malformed or bad signature -> treat as no valid license
  }
  cache = { mtime: st.mtimeMs, claims };
  return claims;
}

// Called on every request. Pure in-memory work once the license is cached.
function getStatus(now = Date.now()) {
  const c = loadClaims();
  if (!c) return { valid: false, code: 'NO_LICENSE', message: 'No valid license installed' };
  if (c.fingerprint !== fingerprint()) return { valid: false, code: 'MACHINE_MISMATCH', message: 'License issued for a different machine' };
  const exp = Date.parse(c.expiresAt);
  const graceEnd = exp + (c.graceDays || 0) * DAY;
  if (now > graceEnd) return { valid: false, code: 'EXPIRED', message: 'License has expired', expiresAt: c.expiresAt };
  if (now > exp) return { valid: true, code: 'GRACE', message: 'License in grace period', expiresAt: c.expiresAt };
  return { valid: true, code: 'VALID', message: 'License valid', expiresAt: c.expiresAt };
}

module.exports = { getStatus };
