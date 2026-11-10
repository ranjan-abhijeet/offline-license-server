export const dynamic = 'force-dynamic';

export function GET(req) {
  return Response.json({
    service: 'reports (Next.js)',
    license: req.headers.get('x-license-status'),
    items: [
      { report: 'Monthly uptime', status: 'ready' },
      { report: 'Energy usage', status: 'pending' },
    ],
  });
}
