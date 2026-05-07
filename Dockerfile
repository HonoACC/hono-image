FROM node:24-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5190

COPY --from=build /app/dist ./dist
COPY server ./server

RUN mkdir -p /app/.hono-image-cache

EXPOSE 5190

CMD ["node", "server/image-task-server.mjs"]
