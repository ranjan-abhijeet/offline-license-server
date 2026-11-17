# One image, used as a sidecar in front of every service. Build context is the REPO ROOT
# (see docker-compose.yml) so the vendor public key can be baked in.
#
# Stage 1: bundle + minify the gate into one file so the readable source doesn't ship.
FROM node:22-alpine AS build
WORKDIR /src
COPY gate/server.js gate/verify.js ./
RUN npx -y esbuild@0.24.2 server.js --bundle --platform=node --format=cjs --minify --outfile=gate.cjs

FROM node:22-alpine
WORKDIR /app
COPY --from=build /src/gate.cjs ./gate.cjs
COPY keys/public.pem ./public.pem
RUN chmod -R a+rX /app
USER node
CMD ["node", "gate.cjs"]
