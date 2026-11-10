import { headers } from 'next/headers';

export default async function Page() {
  const h = await headers();
  return (
    <main>
      <h1>Reports service (Next.js)</h1>
      <p>You only see this page because Caddy's forward_auth confirmed the license.</p>
      <p>
        License status: <b>{h.get('x-license-status')}</b>, expires {h.get('x-license-expires')}
      </p>
      <p>
        JSON API: <a href="/reports/api/items">/reports/api/items</a>
      </p>
    </main>
  );
}
