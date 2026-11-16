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
curl localhost:8080/orders/items
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

## Defense in depth: per-service license gate (sidecar)

Enforcement does **not** rely on the edge Caddy any more. Each service runs behind its own tiny
**license gate** (`gate/`), so editing or removing the edge Caddyfile cannot turn licensing off.

```
 edge Caddy ──► orders-api:8001 ─┐  (shared network namespace)
                                 ├─ orders-gate  → checks license → 127.0.0.1:8000  orders-api (app)
                                 └─ app binds 127.0.0.1 only, so the gate is the ONLY way in
```

How it holds together:

- **One gate image** (`gate/Dockerfile`) is placed in front of every service via
  `network_mode: "service:<app>"`, which shares the app's network namespace.
- **The app binds `127.0.0.1` only** — set by the run command (`--host 127.0.0.1`) or `HOSTNAME=127.0.0.1`,
  **no application code change**. Nothing on the service network can reach the app except its gate.
- **The gate verifies the license locally** using the baked-in public key and the shared `license-data`
  volume, so it keeps enforcing **even if `license-service` is down**. It re-reads only when the license
  file changes, so the hot path is just date math.
- **Changing the rules never touches a team's codebase** — rebuild the one gate image and redeploy.

### Protecting a new service

No code changes to the service. In `docker-compose.yml`: make the app bind loopback, then copy a gate block.

```yaml
  my-svc:
    build: ./services/my-svc
    command: ["<run the app on 127.0.0.1:PORT>"]   # or environment: { HOSTNAME: 127.0.0.1 }
    networks: [backend]

  my-svc-gate:
    build: { context: ., dockerfile: gate/Dockerfile }
    environment: { LISTEN_PORT: <edge-facing port>, UPSTREAM_PORT: <app PORT> }
    volumes:
      - license-data:/data:ro
      - /etc/machine-id:/host/machine-id:ro
    network_mode: "service:my-svc"
    depends_on: [my-svc]
```

Then point the edge Caddy route at `my-svc:<LISTEN_PORT>`.

Caveat (unchanged): the customer owns the host, so this raises the cost of bypassing rather than making it
impossible. Its value is that there is no longer a single file or container whose removal disables licensing.

## Shipping images to colleagues / an air-gapped customer

Images are built on YOUR machine and carried over as files (no registry needed). The easiest way is the
helper script, which generates a key pair if needed, builds, and writes one gzipped tar:

```bash
bash build-and-save.sh               # -> license-poc-YYYYMMDD.tar.gz
```

Send that `.tar.gz` plus `docker-compose.yml` and the `caddy/` folder. On the receiving machine:

```bash
docker load -i license-poc-YYYYMMDD.tar.gz
docker compose up -d --no-build      # uses the loaded images, never rebuilds (no source needed)
```

Equivalent manual steps if you'd rather not use the script:

```bash
docker compose build
docker save -o license-poc.tar \
  license-poc-license-service license-poc-orders-api \
  license-poc-inventory license-poc-reports caddy:2.10
```

Notes:
- Build on the receiver's CPU architecture (e.g. x86-64). The source code is NOT in the bundle.
- The receiving host must be Linux (the fingerprint reads the host's `/etc/machine-id`).
- `--no-build` makes Compose use only the loaded images, so colleagues don't need the Dockerfiles or source.

### Test the save/load round-trip on your own machine first

You can prove the exported images work before sending them, without a second machine:

```bash
bash build-and-save.sh
docker compose down
docker image rm license-poc-license-service license-poc-orders-api \
                 license-poc-inventory license-poc-reports
docker load -i license-poc-*.tar.gz
docker compose up -d --no-build
curl localhost:8080/orders/items     # import a license first; see below
```

### Getting each colleague's machine fingerprint

The license is bound to the host via `/etc/machine-id`, so a license issued for your machine will return
`MACHINE_MISMATCH` on theirs. Each colleague sends you their own fingerprint, which they can read once the
stack is up (no license required — these endpoints are not gated):

- Browser: open `http://localhost:8080/license` — shown at the top of the page.
- Terminal: `curl -s localhost:8080/license/api/fingerprint`

You then issue a license for that value and send back the `.lic`:

```bash
node tools/license-cli.mjs issue --customer "Colleague A" --fingerprint <their-FP> --days 30 --out colleagueA.lic
```

They import it with `curl -F file=@colleagueA.lic localhost:8080/license/api/import`. For internal testing only,
you could instead ship them `tools/` + `keys/private.pem` so they self-issue — but never do that outside a
trusted team, since the private key can mint unlimited licenses.

## Code hiding (what ships in the images)

- **Next.js services** (license-service, inventory, reports): the image contains only the minified,
  webpack-bundled `standalone` server output — no `.jsx`/original source files and no source maps.
- **orders-api (Python)**: compiled to sourceless `main.pyc`; the `.py` source never enters the final image.

Caveat: this stops casual copying, not a determined reverse-engineer (minified JS and `.pyc` can both be
decompiled). For stronger protection compile the critical path to a native binary (Nuitka/Cython for Python,
a JS obfuscator for the license logic) and sign the images.

## Rotating the public key / re-issuing licenses

The public key is **baked into the license-service image**. To change it:

```bash
# 1. Vendor: make a NEW key pair (keygen refuses to overwrite, so remove the old one first)
rm keys/private.pem keys/public.pem
node tools/license-cli.mjs keygen

# 2. Rebuild the license-service image so the new public.pem is baked in, then re-save/ship it
docker compose build license-service

# 3. Re-issue EVERY customer's license with the new private key (old licenses no longer verify)
node tools/license-cli.mjs issue --customer "ACME" --fingerprint <FP> --days 365 --out acme.lic

# 4. Customer: import the new license (old one now returns INVALID_SIGNATURE)
curl -F file=@acme.lic localhost:8080/license/api/import
```

Rotating the key invalidates **all** licenses signed with the old key — only do it if the private key
is compromised or you're deliberately cutting over. Keep `keys/private.pem` off every image and out of git.

> **Golden rule:** the public key is baked into the image, so **whenever you run `keygen`, rebuild
> `license-service` before importing any license.** Order that always works:
> `keygen` → `docker compose build license-service` → `issue` → `import`.

## Troubleshooting

**`import` returns `INVALID_SIGNATURE` even though the fingerprint matches.**
The public key baked into the running `license-service` image is older than the private key that signed the
license (usually: you ran `keygen` after the image was last built). The signature is checked before the
fingerprint, so a key mismatch shows up here. Fix by rebuilding so the current `keys/public.pem` is baked in:

```bash
docker compose build license-service
docker compose up -d --force-recreate license-service
curl -F file=@acme.lic localhost:8080/license/api/import      # expect valid
```

Confirm the image carries the same key as disk — these two hashes must match:

```bash
docker compose exec license-service sha256sum /app/public.pem
sha256sum keys/public.pem
```

To check a license file against your disk key without the server:
`node tools/license-cli.mjs inspect acme.lic` (prints `signature: VALID` / `INVALID`).

## Known POC shortcuts / next steps

1. `/license/api/import` is unauthenticated – put it behind your auth (i360) or an admin token.
2. `/etc/machine-id` alone can be copied/cloned (VM clones). Harden by mixing in `/sys/class/dmi/id/product_uuid`
   (needs root in the container), disk serials, or MAC addresses.
4. Containers on Kubernetes/multiple hosts need a different binding (e.g. cluster UID) – this POC assumes one Docker host.
5. If license-service is down, Caddy returns 502 for everything (fail-closed). Add a healthcheck + `restart` (already set).
