# Image trụ giả lập D1 + HMI (powerme-simulator) cho staging — T04/T84. Build từ GỐC repo:
#   docker build -f simulator/d1-hmi/Dockerfile -t powerme-simulator .
# Chỉ dùng cho demo (compose profile `sim`). HMI chưa có xác thực: xem docker-compose.yml.
#
# Mã simulator là Node thuần và chỉ import `ocpp-rpc`. Gói đó không nằm ở workspace riêng mà là
# dependency của @powerme/csms (simulator/ không có package.json), nên cài đúng phiên bản trong
# package-lock bằng `npm ci -w @powerme/csms --omit=dev` (kéo thêm vài MB dependency của csms).
ARG NODE_IMAGE=node:24.18.1-alpine3.24

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/csms/package.json apps/csms/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --ignore-scripts -w @powerme/csms && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node simulator/d1-hmi ./simulator/d1-hmi
USER node
# Biến: CSMS_URL, CP_ID, CP_PASSWORD (Basic Auth), HMI_PORT, HMI_HOST — xem simulator/d1-hmi/README.md.
# HMI_HOST=0.0.0.0 để cổng publish của Docker tới được tiến trình; compose chỉ publish ra
# 127.0.0.1 của máy chủ (truy cập bằng SSH tunnel), KHÔNG ra internet.
ENV HMI_PORT=8100
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.HMI_PORT||8100)+'/api/state').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "simulator/d1-hmi/server.mjs"]
