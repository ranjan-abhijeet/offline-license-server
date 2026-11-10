import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getFingerprint } from './fingerprint';

const DATA_DIR = process.env.LICENSE_DATA_DIR || '/data';
const LICENSE_FILE = path.join(DATA_DIR, 'license.lic');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PUBLIC_KEY_PATH = process.env.LICENSE_PUBLIC_KEY_PATH || '/keys/public.pem';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 10 * 60 * 1000; // allow small NTP corrections
const STATE_WRITE_INTERVAL_MS = 60 * 1000; // persist "last seen" at most once a minute

export class LicenseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Next.js may bundle route handlers separately, so keep shared state on globalThis.
const g = globalThis.__license ??= { loaded: false, license: null, publicKey: null, state: null, lastWrite: 0 };

function publicKey() {
  if (!g.publicKey) g.publicKey = crypto.createPublicKey(fs.readFileSync(PUBLIC_KEY_PATH));
  return g.publicKey;
}

/**
 * License file format (JSON):
 *   { "payload": "<base64 of JSON claims>", "signature": "<base64 Ed25519 signature of the payload string>" }
 */
export function parseAndVerify(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new LicenseError('MALFORMED', 'License file is not valid JSON');
  }
  if (typeof doc?.payload !== 'string' || typeof doc?.signature !== 'string') {
    throw new LicenseError('MALFORMED', 'License file must contain "payload" and "signature"');
  }
  const ok = crypto.verify(null, Buffer.from(doc.payload), publicKey(), Buffer.from(doc.signature, 'base64'));
  if (!ok) throw new LicenseError('INVALID_SIGNATURE', 'License signature is invalid (file tampered or wrong vendor key)');

  const claims = JSON.parse(Buffer.from(doc.payload, 'base64').toString('utf8'));
  for (const k of ['licenseId', 'customer', 'fingerprint', 'issuedAt', 'expiresAt']) {
    if (!claims[k]) throw new LicenseError('MALFORMED', `License is missing "${k}"`);
  }
  return claims;
}

function load() {
  if (g.loaded) return;
  g.loaded = true;
  try {
    g.license = parseAndVerify(fs.readFileSync(LICENSE_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[license] stored license rejected:', e.message);
    g.license = null;
  }
  try {
    g.state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    g.state = { lastSeen: 0 };
  }
}

/** Anti clock-rollback: remember the latest time we've seen; refuse if the clock goes backwards. */
function checkAndRecordClock(now) {
  if (now + CLOCK_TOLERANCE_MS < g.state.lastSeen) return false;
  if (now > g.state.lastSeen) {
    g.state.lastSeen = now;
    if (now - g.lastWrite > STATE_WRITE_INTERVAL_MS) {
      g.lastWrite = now;
      try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(g.state));
      } catch (e) {
        console.error('[license] could not persist state:', e.message);
      }
    }
  }
  return true;
}

function result(valid, code, message, lic, extra = {}) {
  return {
    valid,
    code,
    message,
    machineFingerprint: getFingerprint(),
    license: lic
      ? {
          licenseId: lic.licenseId,
          customer: lic.customer,
          product: lic.product,
          features: lic.features ?? [],
          issuedAt: lic.issuedAt,
          expiresAt: lic.expiresAt,
          graceDays: lic.graceDays ?? 0,
        }
      : null,
    ...extra,
  };
}

/** Evaluated on every request (via Caddy forward_auth). Pure in-memory work, no disk reads. */
export function getStatus(now = Date.now()) {
  load();
  const lic = g.license;
  if (!lic) return result(false, 'NO_LICENSE', 'No license installed', null);

  if (lic.fingerprint !== getFingerprint()) {
    return result(false, 'MACHINE_MISMATCH', 'License was issued for a different machine', lic);
  }
  if (!checkAndRecordClock(now) || now + CLOCK_TOLERANCE_MS < Date.parse(lic.issuedAt)) {
    return result(false, 'CLOCK_TAMPERED', 'System clock appears to have been moved backwards', lic);
  }

  const expires = Date.parse(lic.expiresAt);
  const graceEnd = expires + (lic.graceDays ?? 0) * DAY_MS;
  const daysRemaining = Math.ceil((expires - now) / DAY_MS);

  if (now > graceEnd) return result(false, 'EXPIRED', 'License has expired', lic, { daysRemaining });
  if (now > expires) {
    const graceDaysLeft = Math.ceil((graceEnd - now) / DAY_MS);
    return result(true, 'GRACE', `License expired; grace period ends in ${graceDaysLeft} day(s)`, lic, { daysRemaining, graceDaysLeft });
  }
  return result(true, 'VALID', 'License is valid', lic, { daysRemaining });
}

export function importLicense(text) {
  load();
  const claims = parseAndVerify(text);
  if (claims.fingerprint !== getFingerprint()) {
    throw new LicenseError(
      'MACHINE_MISMATCH',
      `License is for machine ${claims.fingerprint}, this machine is ${getFingerprint() ?? 'UNKNOWN'}`,
    );
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${LICENSE_FILE}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, LICENSE_FILE); // atomic replace
  g.license = claims;
  return getStatus();
}
