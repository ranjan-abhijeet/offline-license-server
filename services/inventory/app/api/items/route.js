export const dynamic = 'force-dynamic';

export function GET(req) {
  return Response.json({
    service: 'inventory (Next.js)',
    license: req.headers.get('x-license-status'),
    items: [
      { sku: 'PUMP-001', qty: 12 },
      { sku: 'VALVE-204', qty: 40 },
    ],
  });
}
