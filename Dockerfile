FROM traefik:v2.11.2 as traefik

FROM node:20 as deps
WORKDIR /app
COPY app/package*.json ./
RUN npm ci --omit=dev

FROM node:20 as build
WORKDIR /app
COPY app/package*.json ./
RUN npm ci
COPY app ./
RUN npm run build

FROM node:20

# copy traefik binary from official image
COPY --from=traefik /usr/local/bin/traefik /usr/local/bin/traefik

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY app/config ./config

EXPOSE 8080 8081 9090
CMD ["node", "dist/index.js"]
