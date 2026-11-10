#!/usr/bin/env node
// Vendor-side license tool. Zero dependencies (Node 18+).
//
//   node tools/license-cli.mjs keygen
//   node tools/license-cli.mjs fingerprint [--machine-id-file /etc/machine-id]
//   node tools/license-cli.mjs issue --customer "ACME" --fingerprint XXXX-... [--days 365 | --expires 2027-12-31]
//                                    [--grace 15] [--features a,b] [--product AMH] [--out acme.lic]
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
    const now = new Date();
    const expiresAt = args.expires
      ? new Date(args.expires)
      : new Date(now.getTime() + Number(args.days ?? 365) * 86400000);
    if (Number.isNaN(expiresAt.getTime())) die('invalid --expires date');

    const claims = {
      licenseId: crypto.randomUUID(),
      product: args.product || 'AMH',
      customer: args.customer,
      fingerprint: args.fingerprint.toUpperCase(),
      features: args.features ? String(args.features).split(',') : [],
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      graceDays: Number(args.grace ?? 15),
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
