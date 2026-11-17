# SETUP.md — deploying the license POC at a customer site

End-to-end operator guide: export the images (vendor), load them (customer), get the fingerprint, install the
license, and verify what actually shipped inside the images. No internet is needed on the customer side.

Roles: **Vendor** = you (hold the private key, issue licenses). **Customer** = the on-prem operator.

Request path at runtime: `client → Caddy (routes) → the service's license-gate (validates) → app (127.0.0.1)`.
The gate is a sidecar *in front of* each app; Caddy routes to the gate, never to the app directly.

---

## 1. Vendor — build & export the images

Build on the **same CPU architecture** the customer runs (usually x86-64). The source code is NOT in the images
(Next.js ships bundled, Python ships compiled `.pyc`).

```bash
# one command: generates keys if missing, builds, writes a gzipped tar
bash build-and-save.sh                 # -> license-poc-YYYYMMDD.tar.gz
```

Manual equivalent:
```bash
docker compose build
docker save \
  license-poc-license-service license-poc-orders-api \
  license-poc-inventory license-poc-reports \
  license-poc-gate \
  caddy:2.10 | gzip > license-poc.tar.gz
```

**Send the customer:** the `.tar.gz`, plus `docker-compose.yml` and the `caddy/` folder. Do **not** send
`keys/private.pem` (it stays with you) or the repo source.

> After any `keygen`, rebuild before shipping — the public key is baked into the images.

---

## 2. Customer — load the images & start the stack

Requirements: a Linux host with Docker + Docker Compose. (Linux because the machine fingerprint reads
`/etc/machine-id`.)

```bash
docker load -i license-poc-*.tar.gz          # import images; nothing is pulled from the internet
docker compose up -d                         # uses the loaded images by name (no build)
docker compose ps                            # all services + *-gate sidecars should be Up
```

At this point every service is running but **blocked** until a license is installed:
```bash
curl -i localhost:8080/orders/items          # 403  {"code":"NO_LICENSE"}
```

---

## 3. Customer — get this machine's fingerprint

The fingerprint identifies this server and is required to issue a license. It's stable per machine and needs no
license to read.

- Browser: open `http://localhost:8080/license` — shown at the top of the page.
- Terminal:
  ```bash
  curl -s localhost:8080/license/api/fingerprint
  # {"fingerprint":"XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"}
  ```

Send that fingerprint string to the vendor.

---

## 4. Vendor — issue a license for that fingerprint

```bash
node tools/license-cli.mjs issue \
  --customer "ACME" \
  --fingerprint "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" \
  --days 365 --grace 15 \
  --out acme.lic

# optional: confirm it before sending
node tools/license-cli.mjs inspect acme.lic   # prints "signature: VALID" + the claims
```

Send `acme.lic` back to the customer. A license is bound to that one fingerprint — it will not work on a
different machine (returns `MACHINE_MISMATCH`).

---

## 5. Customer — install the license & verify

```bash
curl -F file=@acme.lic localhost:8080/license/api/import     # expect: valid, code VALID
# or upload acme.lic at http://localhost:8080/license

curl localhost:8080/orders/items             # 200
curl localhost:8080/inventory/api/items      # 200
curl localhost:8080/reports/api/items        # 200
```

The license is stored in the `license-data` Docker volume, so it survives `docker compose down` / `up` and
container restarts. It is only lost by `docker compose down -v` (then re-import the same `acme.lic`).

Check status any time:
```bash
curl -s localhost:8080/license/api/status
```

---

## 6. Verify what's inside the containers / images

Use these to confirm the images don't carry source or the private key. `--entrypoint sh` inspects an image
without running the app; the Node images are Alpine and the Python image is slim, both have `sh`.

**orders-api (Python) — compiled to native `.so`, no `.py`/`.pyc`:**
```bash
docker run --rm --entrypoint sh license-poc-orders-api -c "ls -l /app; echo '--- any .py/.pyc?'; find /app -name '*.py' -o -name '*.pyc' 2>/dev/null"
# expect: main*.so and license_guard*.so present, no .py or .pyc
```

**license-service (Next.js) — bundled output + baked public key, no source/maps:**
```bash
docker run --rm --entrypoint sh license-poc-license-service -c "ls -l /app; echo '--- key:'; ls -l /app/public.pem; echo '--- source files?'; find /app -name '*.jsx' -o -name '*.map' 2>/dev/null | grep -v node_modules"
# expect: server.js + .next/ bundles, /app/public.pem present, no .jsx and no .map (outside node_modules)
```

**The private key must be absent from every image:**
```bash
for img in license-poc-license-service license-poc-gate; do
  echo "== $img =="; docker run --rm --entrypoint sh "$img" -c "find / -name 'private.pem' 2>/dev/null; echo '(none above = good)'"
done
```

**The gate ships one minified bundle + the public key (no readable source):**
```bash
docker run --rm --entrypoint sh license-poc-gate -c "ls -l /app"   # gate.cjs (minified), public.pem
```

**The apps are loopback-only (baked in) — you can't reach them past the gate:**
```bash
docker compose exec caddy wget -qO- http://orders-api:8001/items   # the gate answers (403 or 200)
docker compose exec caddy wget -qO- http://orders-api:8000/items   # refused: app binds 127.0.0.1 only
```
The `127.0.0.1` bind is in each service's Dockerfile, not in `docker-compose.yml`, so editing the compose file
cannot re-expose an app.

**In-process enforcement (orders-api + inventory):** these two also check the license *inside the app*, so even
if the gate is bypassed they refuse to serve. You can see it by running the app directly, exposed, without a gate:
```bash
docker run --rm -p 8099:8000 -v license-poc_license-data:/data:ro -v /etc/machine-id:/host/machine-id:ro \
  license-poc-orders-api uvicorn main:app --host 0.0.0.0 --port 8000
curl -i localhost:8099/items    # still 403 unless a valid license is in the volume — the app enforces itself
```
`reports` is intentionally gate-only (no in-process check) to illustrate coverage tracking across services.

**Inspect build steps / confirm a mounted key wasn't reintroduced:**
```bash
docker history --no-trunc license-poc-license-service | grep -i public.pem   # shows the COPY of public.pem
docker compose config | grep -i public.pem                                   # should print NOTHING (not mounted)
```

**Export a container's full filesystem to inspect offline (no run):**
```bash
cid=$(docker create license-poc-orders-api); docker export "$cid" -o orders-fs.tar; docker rm "$cid"
tar tf orders-fs.tar | grep -E 'app/main'      # app/main.pyc only
```

---

## Troubleshooting

- `INVALID_SIGNATURE` on import, fingerprint matches → the image was built with an older public key than the one
  that signed the license. Rebuild: `docker compose build license-service orders-gate inventory-gate reports-gate`,
  recreate, re-import. (Full note in README → Troubleshooting.)
- `MACHINE_MISMATCH` → the license was issued for a different machine's fingerprint. Re-issue for this host's.
- `502` from a service → its gate can't reach the app; check the app is listening on `127.0.0.1` and the gate's
  `UPSTREAM_PORT` matches the app port (see AGENTS.md → Ports).
- A gate reports `UPSTREAM_UNAVAILABLE` right after start → the app isn't up yet; it clears on retry.

See README.md for the full reference and AGENTS.md for the architecture and the rules to keep when changing code.
