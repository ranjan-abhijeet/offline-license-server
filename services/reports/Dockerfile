FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER node
EXPOSE 3000
# Bind to loopback ONLY — the license gate (sharing this netns) is the sole ingress.
# The inline HOSTNAME wins over any compose `environment:` override; `exec` keeps PID 1 for clean signals.
CMD ["sh", "-c", "HOSTNAME=127.0.0.1 exec node server.js"]
