import { withLicense } from '../../../lib/license-guard.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // the guard uses node:crypto + node:fs, not the Edge runtime

// In-process license enforcement: this handler refuses to serve without a valid license,
// even if someone bypasses the sidecar gate. One wrap.
export const GET = withLicense((req) =>
  Response.json({
    service: 'inventory (Next.js)',
    license: req.headers.get('x-license-status'),
    items: [
      { sku: 'PUMP-001', qty: 12 },
      { sku: 'VALVE-204', qty: 40 },
    ],
  }),
);
