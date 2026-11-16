# One image, used as a sidecar in front of every service. Build context is the REPO ROOT
# (see docker-compose.yml) so the vendor public key can be baked in.
FROM node:22-alpine
WORKDIR /app
COPY gate/server.js gate/verify.js ./
COPY keys/public.pem ./public.pem
RUN chmod -R a+rX /app
USER node
CMD ["node", "server.js"]
