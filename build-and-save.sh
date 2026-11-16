#!/usr/bin/env bash
# Build all images and export them to a single tar for sharing with colleagues.
# Run from the repo root:  bash build-and-save.sh
set -euo pipefail
cd "$(dirname "$0")"

# 1. Ensure a vendor key pair exists. keys/public.pem gets baked into the license-service
#    image; keys/private.pem stays here with you and must never be shipped.
if [ ! -f keys/private.pem ]; then
  echo ">> No key pair found — generating one (keys/private.pem is vendor-only)."
  node tools/license-cli.mjs keygen
fi

# 2. Build all images. license-service bakes in the CURRENT keys/public.pem, so this must
#    run after any keygen, otherwise imported licenses fail with INVALID_SIGNATURE.
echo ">> Building images..."
docker compose build

# 3. Export the images (plus the Caddy base image) to one gzipped tar.
OUT="license-poc-$(date +%Y%m%d).tar"
echo ">> Saving images to ${OUT}.gz ..."
docker save \
  license-poc-license-service \
  license-poc-orders-api \
  license-poc-inventory \
  license-poc-reports \
  license-poc-gate \
  caddy:2.10 \
  | gzip > "${OUT}.gz"

echo
echo ">> Done: ${OUT}.gz"
echo ">> Send that file plus docker-compose.yml and the caddy/ folder."
echo ">> On the colleague's machine:"
echo "     docker load -i ${OUT}.gz"
echo "     docker compose up -d                 # uses the loaded images by name (no build)"
