#!/usr/bin/env node
// Vendor-side license tool. Zero dependencies (Node 18+).
//
//   node tools/license-cli.mjs keygen
//   node tools/license-cli.mjs fingerprint [--machine-id-file /etc/machine-id]
//   node tools/license-cli.mjs issue --customer "ACME" --fingerprint XXXX-... [--days 365 | --minutes 5 | --expires 2027-12-31]
//                                    [--grace 15 | --grace-minutes 2] [--features a,b] [--product AMH] [--out acme.lic]
//     --minutes / --grace-minutes are for fast expiry testing, e.g.  --minutes 5 --grace 0
//   node tools/license-cli.mjs inspect acme.lic
//
// Keys: keys/private.pem stays with the VENDOR (never ship it). keys/public.pem is mounted into license-service.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY_DIR = path.join(ROOT, 'keys');
const PRIV = path.join(KEY_DIR, 'private.pem');
const PUB = path.join(KEY_DIR, 'public.pem');

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) args[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i];
  else (args._ ??= []).push(rest[i]);
}
const die = (m) => { console.error(m); process.exit(1); };

// Must match license-service/lib/fingerprint.js
function computeFingerprint(machineId) {
  const hex = crypto.createHash('sha256').update(`amh-license-v1:${machineId.trim()}`).digest('hex').slice(0, 32).toUpperCase();
  return hex.match(/.{4}/g).join('-');
}

switch (cmd) {
  case 'keygen': {
    if (fs.existsSync(PRIV)) die(`${PRIV} already exists – refusing to overwrite (all issued licenses depend on it)`);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(KEY_DIR, { recursive: true });
    fs.writeFileSync(PRIV, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(PUB, publicKey.export({ type: 'spki', format: 'pem' }));
    console.log(`Wrote ${PRIV} (keep secret) and ${PUB}`);
    break;
  }

  case 'fingerprint': {
    const file = args['machine-id-file'] || '/etc/machine-id';
    console.log(computeFingerprint(fs.readFileSync(file, 'utf8')));
    break;
  }

  case 'issue': {
    if (!args.customer || !args.fingerprint) die('issue requires --customer and --fingerprint');
    const num = (v, name) => {
      const n = Number(v);
      if (!Number.isFinite(n)) die(`--${name} must be a number`);
      return n;
    };

    // Expiry precedence: --expires (absolute date) > --minutes (testing) > --days (default 365).
    const now = new Date();
    let expiresAt;
    if (args.expires) expiresAt = new Date(args.expires);
    else if (args.minutes != null) expiresAt = new Date(now.getTime() + num(args.minutes, 'minutes') * 60000);
    else expiresAt = new Date(now.getTime() + num(args.days ?? 365, 'days') * 86400000);
    if (Number.isNaN(expiresAt.getTime())) die('invalid --expires date');

    // Grace: --grace-minutes (testing) wins over --grace (days). Stored as graceDays (may be fractional).
    const graceDays = args['grace-minutes'] != null
      ? num(args['grace-minutes'], 'grace-minutes') / 1440
      : num(args.grace ?? 15, 'grace');

    const claims = {
      licenseId: crypto.randomUUID(),
      product: args.product || 'AMH',
      customer: args.customer,
      fingerprint: args.fingerprint.toUpperCase(),
      features: args.features ? String(args.features).split(',') : [],
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      graceDays,
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64');
    const signature = crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(fs.readFileSync(PRIV))).toString('base64');

    const out = args.out || `${args.customer.replace(/\W+/g, '_').toLowerCase()}.lic`;
    fs.writeFileSync(out, JSON.stringify({ payload, signature }, null, 2));
    console.log(`Wrote ${out}\n`, claims);
    break;
  }

  case 'inspect': {
    const file = args._?.[0] || die('usage: inspect <file.lic>');
    const { payload, signature } = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ok = crypto.verify(null, Buffer.from(payload), crypto.createPublicKey(fs.readFileSync(PUB)), Buffer.from(signature, 'base64'));
    console.log('signature:', ok ? 'VALID' : 'INVALID');
    console.log(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')));
    break;
  }

  default:
    die('commands: keygen | fingerprint | issue | inspect   (see header of this file)');
}
