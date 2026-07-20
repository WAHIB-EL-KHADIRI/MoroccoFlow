FROM node:22.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
RUN npm ci --include-workspace-root
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
ARG BASE_PATH=/
ARG VITE_API_BASE_URL=/api/v1
ENV BASE_PATH=$BASE_PATH
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:1.29.0-alpine AS runtime
COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
