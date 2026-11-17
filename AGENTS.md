# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo. Read this before changing code.

## What this is

A **proof-of-concept on-prem license server** for a containerized, multi-microservice web app that runs on
customers' own servers — often **air-gapped** (no internet). The license is **not** sent with each request;
it lives on the server and is validated on **every** request. Enforcement is done by a small **sidecar gate**
in front of each service, not by the client and not only at the edge proxy.

This is a POC: favor small, readable, dependency-light code over cleverness. Do not add frameworks or heavy
libraries without being asked.

## Tech stack

- **license-service** and **gate**: Node.js 22, Next.js 15 (license-service only), plain `node:*` modules.
- **Sample services**: `orders-api` (Python 3.12 / FastAPI), `inventory` + `reports` (Next.js 15).
- **Edge routing**: Caddy 2 (`caddy/Caddyfile`).
- **Orchestration**: Docker Compose (`docker-compose.yml`), one host, two networks.
- **Crypto**: Ed25519. Node side uses `node:crypto`; the Python in-process client uses `cryptography`.
- **In-process clients** (`clients/`): Python (`cryptography` + Starlette middleware) and Node (`node:crypto`).
- **Code hardening**: `orders-api` compiled to native `.so` (Nuitka); `gate` bundled+minified (esbuild); Next apps minified.

## Repository map

```
caddy/Caddyfile            Edge reverse proxy. ROUTING ONLY — it does NOT verify licenses.
docker-compose.yml         The whole stack: apps + a license gate sidecar per app.
build-and-save.sh          Build all images and export to a gzipped tar for shipping.
SETUP.md                   Operator deployment guide: export, load, fingerprint, license, verify images.
README.md                  Full reference (flows, rotation, troubleshooting, hardening notes).
keys/                      Vendor keys. public.pem is baked into images. private.pem is git-ignored, vendor-only.
tools/license-cli.mjs      VENDOR-side CLI: keygen / fingerprint / issue / inspect. Uses the PRIVATE key.
docs/license-flow.excalidraw   Data-flow diagram.

license-service/           Next.js app: license admin UI + API. basePath "/license".
  lib/license.js           Core verify/import/status logic (signature, machine, expiry, grace, clock).
  lib/fingerprint.js       Machine fingerprint from the mounted host /etc/machine-id.
  app/api/verify/route.js  Legacy edge forward_auth endpoint (kept; gates are the real enforcement now).
  app/api/import/route.js  POST a license (multipart "file" or raw JSON body) -> writes license-data volume.
  app/api/status/route.js  Full status JSON.
  app/api/fingerprint/route.js   This machine's fingerprint (customer sends it to the vendor).

gate/                      The sidecar. ONE image used in front of every service.
  verify.js                Local, read-only license verification (baked public key). Same algorithm as license-service.
  server.js                ~40-line reverse proxy: check license -> 403, or proxy to the app on 127.0.0.1.
                           (Shipped bundled+minified as gate.cjs — see gate/Dockerfile.)

clients/                   Reusable IN-PROCESS license clients (layer-2 enforcement). Same algorithm as the gate.
  python/license_guard.py  FastAPI/Starlette middleware: app.add_middleware(LicenseMiddleware).
  node/license-guard.mjs   Next.js route wrapper: export const GET = withLicense(handler).

services/orders-api/       FastAPI sample. Uses license_guard in-process; ships as native .so (Nuitka), no .py/.pyc.
services/inventory/        Next.js sample. Uses license-guard in-process (route wrapper). basePath "/inventory".
services/reports/          Next.js sample. basePath "/reports". GATE-ONLY (no in-process guard) — the coverage example.
```

## Architecture & data flow

Two flows (see `docs/license-flow.excalidraw`):

**Provisioning (one-time / renewal):** customer reads fingerprint (`GET /license/api/fingerprint`) →
sends it to the vendor → vendor runs `license-cli issue` (signs with the **private key**) → `license.lic` →
customer `POST /license/api/import` → `license-service` verifies and writes it to the shared `license-data` volume.

**Runtime (every request):** client → **edge Caddy** (`:8080`, routing only) → the target service's
**license-gate** (sidecar) → gate verifies the license locally (baked public key, reads the shared volume +
`/etc/machine-id`) → if valid, proxy to the app on **127.0.0.1**; else **403**.

Why the gate pattern: each app binds `127.0.0.1` only and the gate shares its network namespace
(`network_mode: "service:<app>"`), so the gate is the ONLY way in. Removing/editing the edge Caddyfile
cannot disable licensing, and each gate keeps working even if `license-service` is down.

**Two enforcement layers:** (1) the sidecar **gate** (network-level, every service); (2) the in-process
**`clients/`** guard baked into `orders-api` + `inventory` (process-level — survives running the container
directly; `reports` is gate-only). Both use the identical verify algorithm.

**License distribution:** there is no per-service copy. `import` writes one `license.lic` into the
**`license-data`** named volume (license-service has it read-write; it is the only writer). Every gate and every
in-process app mounts that same volume **read-only** plus `/etc/machine-id`, and re-reads the file when its mtime
changes — so one import applies everywhere, live, no restart. An in-process service without the `license-data`
mount will 403 (it sees "no license").

## License file format

`license.lic` is JSON: `{ "payload": base64(claimsJSON), "signature": base64(Ed25519(payload)) }`.
Claims: `licenseId, product, customer, fingerprint, features[], issuedAt, expiresAt, graceDays`.
`expiresAt` is an absolute ISO timestamp and `graceDays` is a number that MAY be fractional (the CLI's
`--minutes` / `--grace-minutes` testing flags produce short/fractional values). The verifiers compute from the
absolute timestamp, so minute-level expiry needs no reader change. The payload is **not** encrypted (anyone can
read it); integrity comes from the signature.

Status codes (keep these stable — they are a contract): `VALID`, `GRACE`, `EXPIRED`, `NO_LICENSE`,
`MACHINE_MISMATCH`, `CLOCK_TAMPERED`.

## Security invariants — do not break these

1. **The private key never ships.** `keys/private.pem` stays with the vendor and is git-ignored. It must never
   be COPYed into any image, referenced by any service, or committed. Only `tools/license-cli.mjs` uses it.
2. **The public key is baked into images, never mounted.** `license-service`, `gate`, `orders-api`, and
   `inventory` Dockerfiles `COPY keys/public.pem`. Do not reintroduce a `./keys/public.pem` volume mount
   (a mounted key is swappable).
3. **The fingerprint algorithm must stay identical in ALL FIVE places:** `tools/license-cli.mjs`,
   `license-service/lib/fingerprint.js`, `gate/verify.js`, `clients/python/license_guard.py`, and
   `clients/node/license-guard.mjs`. It is `sha256("amh-license-v1:" + machineId).hex[:32].toUpperCase()` grouped
   into 4-char blocks. Change one → change all, or licenses mismatch somewhere.
4. **Apps bind 127.0.0.1 only, baked into the image.** Each service's Dockerfile forces the loopback bind
   (`orders-api`: `uvicorn --host 127.0.0.1` in CMD; Next apps: `CMD ["sh","-c","HOSTNAME=127.0.0.1 exec node server.js"]`
   — the inline assignment beats any compose `environment:` override). This is deliberately NOT set in
   docker-compose.yml, so editing the shipped compose file cannot re-expose an app. Do not move the bind back
   into compose, add `ports:` to an app service, or make an app listen on `0.0.0.0`. (`license-service` is the
   exception — it is not gated and must keep `HOSTNAME=0.0.0.0`.)
5. **Signature is checked before expiry/machine.** Order matters for correct error codes.
6. **`backend` network is `internal: true`.** Don't expose service ports to the host; only the edge Caddy
   publishes a port (`8080`).

## Build / run / test

```bash
docker compose up -d --build          # start everything (add --build after code/Dockerfile changes)
docker compose logs -f <service>      # debug
docker compose down                   # stop, KEEP the license volume
docker compose down -v                # stop, WIPE the license (forces re-import)
```

Import + test (license is machine-bound, so issue against THIS host's fingerprint):
```bash
FP=$(curl -s localhost:8080/license/api/fingerprint | sed -E 's/.*"fingerprint":"([^"]+)".*/\1/')
node tools/license-cli.mjs issue --customer ACME --fingerprint "$FP" --days 365 --grace 15 --out acme.lic
curl -F file=@acme.lic localhost:8080/license/api/import   # expect valid
curl localhost:8080/orders/items                            # 200 when valid, 403 otherwise
```

There is no automated test suite yet. If you add logic, verify by the curl flows above (no-license → 403,
valid → 200, expired → 403, machine-mismatch → 403, tampered file → 403). `license-cli inspect <file>` checks a
license's signature against `keys/public.pem` without the server.

## Ports (within each app's shared netns)

| Service    | app (127.0.0.1) | gate (edge-facing) | Caddy route        |
|------------|-----------------|--------------------|--------------------|
| orders-api | 8000            | 8001               | `/orders/*` (strip)|
| inventory  | 3000            | 3001               | `/inventory*`      |
| reports    | 3000            | 3001               | `/reports*`        |
| license-service | 3000 (direct) | —              | `/license*` (ungated) |

## Common tasks

**Protect a new service** (no app code change): bake the loopback bind into the service's Dockerfile (CMD/ENV,
not compose — see invariant #4), add a gate block to `docker-compose.yml` copied from an existing one with the
right `UPSTREAM_PORT`/`LISTEN_PORT` and `network_mode: "service:<app>"`, then add a Caddy route to
`<app>:<LISTEN_PORT>`. See README "Protecting a new service".

**Change what the gate enforces** (e.g., add a feature-flag check): edit `gate/verify.js` only, rebuild the gate
images. Do not duplicate license logic into the individual services — that's the whole point of the sidecar.

**Change license fields / claims**: update `tools/license-cli.mjs` (issuer) AND every reader —
`license-service/lib/license.js`, `gate/verify.js`, `clients/python/license_guard.py`,
`clients/node/license-guard.mjs`. Keep them in sync.

**Add in-process enforcement to a service**: integrate the matching `clients/` library as framework middleware
(one line: `app.add_middleware(LicenseMiddleware)` / `export const GET = withLicense(handler)`), bake the public
key into its image, and mount `license-data:/data:ro` + `/etc/machine-id` in compose. This is layer 2 — keep the
gate too. `reports` is deliberately left without it as the coverage-governance example.

**Rotate keys**: `rm keys/*.pem && node tools/license-cli.mjs keygen` → `docker compose build` (rebuilds so the
new public key is baked in) → re-issue every license. Rotating invalidates all existing licenses. **Golden rule:
after any keygen, rebuild before importing**, or imports fail with `INVALID_SIGNATURE`.

## Conventions & gotchas

- Keep code dependency-free where it already is (`gate/`, `tools/`, `lib/`). Prefer `node:*` built-ins.
- Next.js services use `output: "standalone"`; the final image ships only the bundled server (no source, no maps).
  Keep multi-stage builds — don't COPY source into the final stage.
- **Code hardening (keep it):** `orders-api` ships native `.so` modules compiled by **Nuitka** (app + license
  guard) — no `.py`/`.pyc` in the final image; needs `cryptography` at runtime (in requirements.txt). The `gate`
  ships one bundled+minified `gate.cjs` (esbuild). Next apps ship minified `standalone` bundles. Don't add raw
  source to a final image, and don't commit `__pycache__/` or Nuitka `*.build/` dirs. String literals still
  survive compilation — that's expected; the guarantee is "no secret in the image," not "unreadable."
- Build context for `license-service`, `gate`, `orders-api`, and `inventory` is the **repo root** (they need
  `keys/public.pem`, and the service builds vendor `clients/` in). Their COPY paths are prefixed accordingly.
  The root `.dockerignore` keeps the context small and excludes the private key.
- Every service declares an explicit `image:` tag (`license-poc-*`) alongside `build:`, so a loaded image is used
  by name on `docker compose up` without `--no-build`. All three gates share one image, `license-poc-gate`
  (identical; they differ only by env). `build-and-save.sh` ships 6 images: the 4 services, `license-poc-gate`,
  and `caddy:2.10`. If you add/rename a service image, update `build-and-save.sh` and SETUP.md's save list.
- Do not commit `keys/*.pem`, `*.lic`, `node_modules/`, `.next/`, or `__pycache__/`.
- This is a single-Docker-host POC. Kubernetes/multi-host binding and an authenticated import endpoint are known
  gaps (see README "Known POC shortcuts").

## Attribution

Hosted-on-customer-hardware licensing is inherently bypassable by a root user; the design raises the cost of
bypassing, it does not make it impossible. Keep that framing honest in docs and comments — don't claim the POC
is tamper-proof.
