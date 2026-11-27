# Dashboard vận hành (React + Vite) cho staging — BE-46.
#
# Build file tĩnh bằng Node rồi phục vụ bằng Caddy (không TLS, chỉ trong mạng compose). Caddy chính
# (infra/staging/Caddyfile) proxy mọi đường không phải /api, /ocpp, /health, /billing/vnpay tới đây.
# API: trình duyệt gọi cùng origin https://<DOMAIN>/api/{auth,operator,admin}/v1/* (JWT, ADR-0018).
# Build từ GỐC repo:  docker build -f apps/dashboard/Dockerfile .
ARG NODE_IMAGE=node:24.18.1-alpine3.24
ARG CADDY_IMAGE=caddy:2.11.7-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/csms/package.json apps/csms/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY apps/dashboard apps/dashboard
# Khoá Tile Vietmap cho bản đồ màn 18 (FE-03c, D23). Vite nhúng nó vào bundle, nên đây phải là khoá
# chỉ có quyền Tile (lộ ra trình duyệt), không bao giờ là khoá Search / Route của CSMS. Trống →
# màn 18 hiện "chưa cấu hình khoá bản đồ", danh sách vẫn dùng được.
ARG VITE_VIETMAP_TILE_KEY=
ENV VITE_VIETMAP_TILE_KEY=${VITE_VIETMAP_TILE_KEY}
RUN npm run build -w @powerme/dashboard

FROM ${CADDY_IMAGE} AS runtime
COPY apps/dashboard/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/dashboard/dist /srv
EXPOSE 8080
