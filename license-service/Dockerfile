# NOTE: build context is the REPO ROOT (see docker-compose.yml), not this folder,
# so the vendor public key (../keys/public.pem) can be baked into the image.
# COPY paths are therefore prefixed with license-service/.
FROM node:22-alpine AS build
WORKDIR /app
COPY license-service/package.json license-service/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY license-service/ .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
# Public key is baked in (not mounted), so a customer cannot swap it on disk.
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 LICENSE_PUBLIC_KEY_PATH=/app/public.pem
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY keys/public.pem ./public.pem
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
