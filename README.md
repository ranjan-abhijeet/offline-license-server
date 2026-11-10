# On-prem License Server – POC

Every request to every microservice is license-checked by **Caddy `forward_auth`**, which asks the
**license-service** (Next.js) "is the license valid?" before routing. Clients never send the license;
it lives on the server.

```
             :8080
 browser ──► Caddy ──(1) GET /license/api/verify ──► license-service  ── 200 / 403
               │   (2) only if 200, proxy request
               ├──► /orders/*     → orders-api   (FastAPI)
               ├──► /inventory/*  → inventory    (Next.js)
               ├──► /reports/*    → reports      (Next.js)
               └──► /license/*    → license-service  (NOT gated: UI + import API)
```

The `backend` Docker network is `internal: true`, so services can only be reached through Caddy (the check
cannot be bypassed by hitting a service port directly).

## Layout

| Path | What |
|---|---|
| `license-service/` | Next.js: license UI + API (`lib/license.js` has all the logic) |
| `services/orders-api/` | FastAPI sample service |
| `services/inventory/`, `services/reports/` | Next.js sample services |
| `caddy/Caddyfile` | Routing + `forward_auth` |
| `tools/license-cli.mjs` | **Vendor-side** key/license generator (no dependencies) |
| `keys/` | `private.pem` (vendor only, never ship) and `public.pem` (mounted into license-service) |

## Run it

```bash
# 1. Vendor: create the signing key pair (once, ever)
node tools/license-cli.mjs keygen

# 2. Start the stack
docker compose up -d --build

# 3. Everything is blocked until a license is imported
curl -i localhost:8080/orders/items           # 403 {"code":"NO_LICENSE"}

# 4. Customer: get this server's fingerprint (or open http://localhost:8080/license)
curl localhost:8080/license/api/fingerprint

# 5. Vendor: issue a license bound to that fingerprint
node tools/license-cli.mjs issue --customer "ACME" --fingerprint <FP> --days 365 --grace 15 --out acme.lic

# 6. Customer: import it (UI upload, or API)
curl -F file=@acme.lic localhost:8080/license/api/import

# 7. Services now work
curl localhost:8080/inventory/api/items
open http://localhost:8080/reports
```

## License endpoints (all under `/license/api`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/import` | Import a license (multipart field `file`, or raw JSON body). Verifies signature + machine before saving |
| GET | `/status` | Full status JSON (code, message, expiry, days remaining, fingerprint) |
| GET | `/verify` | Used by Caddy. `200` + `X-License-*` headers if valid, `403` otherwise |
| GET | `/fingerprint` | This machine's fingerprint |

Status codes: `VALID`, `GRACE` (expired but inside grace days – still allowed), `EXPIRED`, `NO_LICENSE`,
`MACHINE_MISMATCH`, `CLOCK_TAMPERED`. Services receive `X-License-Status/Expires/Customer` request headers.

## How it works

- **License file** = `{ payload: base64(JSON claims), signature: Ed25519(payload) }`. Only the vendor's private key
  can sign; the server only holds the public key, so editing the expiry breaks the signature.
- **Machine binding** – fingerprint = `sha256("amh-license-v1:" + host /etc/machine-id)`, mounted read-only into
  the container, so it identifies the host and survives container rebuilds.
- **Per-request cost** – the license is verified once (startup/import) and kept in memory; `/verify` only does
  date math, no disk or crypto.
- **Clock rollback** – the service persists the latest time it has seen; if the clock goes back more than 10 min, it
  returns `CLOCK_TAMPERED` until the clock is corrected.

## Known POC shortcuts / next steps

1. `/license/api/import` is unauthenticated – put it behind your auth (i360) or an admin token.
2. Bake `public.pem` into the license-service image instead of mounting it (a mounted key can be swapped by the customer).
3. `/etc/machine-id` alone can be copied/cloned (VM clones). Harden by mixing in `/sys/class/dmi/id/product_uuid`
   (needs root in the container), disk serials, or MAC addresses.
4. Containers on Kubernetes/multiple hosts need a different binding (e.g. cluster UID) – this POC assumes one Docker host.
5. If license-service is down, Caddy returns 502 for everything (fail-closed). Add a healthcheck + `restart` (already set).
