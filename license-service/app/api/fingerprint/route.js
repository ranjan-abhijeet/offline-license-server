import { getFingerprint } from '../../../lib/fingerprint';

export const dynamic = 'force-dynamic';

// The customer sends this value to the vendor, who issues a license bound to it.
export function GET() {
  return Response.json({ fingerprint: getFingerprint() });
}
