# NOTE: build context is the REPO ROOT (see docker-compose.yml) so this image can bake in the
# shared license client (clients/node/license-guard.mjs) and the vendor public key.
FROM node:22-alpine AS build
WORKDIR /app
COPY services/inventory/package.json services/inventory/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/inventory/ .
# Vendor the canonical Node license client into the app so the route can import it at build.
COPY clients/node/license-guard.mjs ./lib/license-guard.mjs
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1 LICENSE_PUBLIC_KEY_PATH=/app/public.pem
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY keys/public.pem ./public.pem
USER node
EXPOSE 3000
# Bind to loopback ONLY — the gate shares this netns; baked in so compose can't re-expose it.
CMD ["sh", "-c", "HOSTNAME=127.0.0.1 exec node server.js"]
