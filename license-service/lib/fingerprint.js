import crypto from 'node:crypto';
import fs from 'node:fs';

// The HOST's /etc/machine-id is bind-mounted into the container (see docker-compose.yml),
// so the fingerprint identifies the server, not the (ephemeral) container.
const MACHINE_ID_PATH = process.env.HOST_MACHINE_ID_PATH || '/host/machine-id';

/** Same algorithm as `tools/license-cli.mjs fingerprint` – keep them in sync. */
export function computeFingerprint(machineId) {
  const hex = crypto
    .createHash('sha256')
    .update(`amh-license-v1:${machineId.trim()}`)
    .digest('hex')
    .slice(0, 32)
    .toUpperCase();
  return hex.match(/.{4}/g).join('-');
}

export function getFingerprint() {
  if (globalThis.__hostFingerprint !== undefined) return globalThis.__hostFingerprint;
  let fp = null;
  try {
    const id = fs.readFileSync(MACHINE_ID_PATH, 'utf8').trim();
    if (id) fp = computeFingerprint(id);
  } catch {
    // not mounted / unreadable -> no fingerprint -> licenses can never match
  }
  globalThis.__hostFingerprint = fp;
  return fp;
}
