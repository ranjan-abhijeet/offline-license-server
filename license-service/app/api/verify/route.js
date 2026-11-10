import { getStatus } from '../../../lib/license';

export const dynamic = 'force-dynamic';

// Called by Caddy forward_auth on EVERY gated request.
// 2xx -> Caddy forwards the request to the service; anything else is returned to the client.
export function GET() {
  const s = getStatus();
  if (s.valid) {
    return new Response(null, {
      status: 200,
      headers: {
        'X-License-Status': s.code,
        'X-License-Expires': s.license.expiresAt,
        'X-License-Customer': s.license.customer,
      },
    });
  }
  return Response.json({ error: 'LICENSE_INVALID', code: s.code, message: s.message }, { status: 403 });
}
