import { getStatus } from '../../../lib/license';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(getStatus());
}
