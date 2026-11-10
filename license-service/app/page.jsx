'use client';
import { useEffect, useState } from 'react';

const API = '/license/api'; // basePath must be included for client-side fetches

export default function Page() {
  const [status, setStatus] = useState(null);
  const [msg, setMsg] = useState('');

  const refresh = () => fetch(`${API}/status`).then((r) => r.json()).then(setStatus);
  useEffect(() => { refresh(); }, []);

  async function upload(e) {
    e.preventDefault();
    const res = await fetch(`${API}/import`, { method: 'POST', body: new FormData(e.target) });
    const body = await res.json();
    setMsg(res.ok ? 'License imported.' : `${body.error}: ${body.message}`);
    refresh();
  }

  return (
    <main>
      <h1>License Manager</h1>
      <p>
        Machine fingerprint: <code>{status?.machineFingerprint ?? '…'}</code>
        <br />
        <small>Send this to the vendor to get a license for this server.</small>
      </p>

      <h2>Status</h2>
      {status && (
        <p style={{ color: status.valid ? 'green' : 'crimson' }}>
          <b>{status.code}</b> – {status.message}
        </p>
      )}
      <pre style={{ background: '#f4f4f4', padding: 12, overflow: 'auto' }}>{JSON.stringify(status, null, 2)}</pre>

      <h2>Import license</h2>
      <form onSubmit={upload}>
        <input type="file" name="file" accept=".lic,.json" required /> <button type="submit">Import</button>
      </form>
      {msg && <p>{msg}</p>}
    </main>
  );
}
