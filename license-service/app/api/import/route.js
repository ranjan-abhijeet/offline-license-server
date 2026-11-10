import { importLicense, LicenseError } from '../../../lib/license';

export const dynamic = 'force-dynamic';

// Accepts either multipart/form-data with a "file" field, or the raw license JSON as the body.
export async function POST(req) {
  try {
    let text;
    if ((req.headers.get('content-type') || '').includes('multipart/form-data')) {
      const file = (await req.formData()).get('file');
      if (!file || typeof file === 'string') throw new LicenseError('MALFORMED', 'Form field "file" is required');
      text = await file.text();
    } else {
      text = await req.text();
    }
    return Response.json(importLicense(text));
  } catch (e) {
    if (e instanceof LicenseError) return Response.json({ error: e.code, message: e.message }, { status: 400 });
    console.error(e);
    return Response.json({ error: 'INTERNAL', message: e.message }, { status: 500 });
  }
}
