FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app/daemon

COPY daemon/package*.json ./
RUN npm ci

COPY daemon/tsconfig.json ./
COPY daemon/src ./src
COPY megax.config.json /app/megax.config.json

RUN npm run build

EXPOSE 4040

CMD ["node", "dist/index.js", "--serve", "--port", "4040"]

