# Image CSMS (powerme-csms) cho staging — T04/T84. Build từ GỐC repo vì dùng npm workspaces:
#   docker build -f apps/csms/Dockerfile -t powerme-csms .
# CI: .github/workflows/deploy-staging.yml. Triển khai: infra/staging/README.md.
#
# Ba stage: build (có devDependencies để chạy tsc) → deps (chỉ dependency production) → runtime
# (dist/, drizzle/, scripts/, seed.sql + node_modules production; không có mã nguồn TS, test, tsc).
# Base GHIM tag cụ thể (không `latest`); đổi phiên bản = sửa một dòng ARG, cả ba stage dùng chung.
ARG NODE_IMAGE=node:24.18.1-alpine3.24

# ---- build: cài đủ dependency, biên dịch TypeScript ----
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Chỉ copy manifest trước để lớp `npm ci` được cache khi mã nguồn đổi. Phải có package.json của
# MỌI workspace (apps/*, packages/*) thì npm ci mới khớp package-lock.json.
COPY package.json package-lock.json ./
COPY apps/csms/package.json apps/csms/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/
# --ignore-scripts: bỏ `prepare` (setup-hooks.sh chỉ dành cho máy dev, cần git).
RUN npm ci --ignore-scripts
COPY apps/csms/tsconfig.json apps/csms/tsconfig.build.json apps/csms/
COPY apps/csms/src apps/csms/src
RUN npm run build -w @powerme/csms

# ---- deps: chỉ dependency production của @powerme/csms ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/csms/package.json apps/csms/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/mobile/package.json apps/mobile/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --ignore-scripts -w @powerme/csms && npm cache clean --force

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/csms
# node_modules ở /app/node_modules (hoisted) — Node tự tìm lên hai cấp từ /app/apps/csms.
COPY --from=deps --chown=node:node /app/node_modules /app/node_modules
COPY --chown=node:node package.json /app/package.json
COPY --chown=node:node apps/csms/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/csms/dist ./dist
COPY --chown=node:node apps/csms/drizzle ./drizzle
COPY --chown=node:node apps/csms/scripts/migrate.mjs apps/csms/scripts/seed-demo.mjs ./scripts/
COPY --chown=node:node apps/csms/demo/seed.sql ./demo/seed.sql
USER node
# OCPP-J (wss kết thúc TLS ở Caddy). Console: xem CONSOLE_HOST bên dưới.
EXPOSE 9000 3000
# /health nằm trên cổng console. Probe 127.0.0.1 trong chính container nên đúng cả khi bind 0.0.0.0.
# CONSOLE_ENABLED=false thì container sẽ báo unhealthy — staging luôn bật console.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.CONSOLE_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# node là PID 1: SIGTERM của `docker stop` tới thẳng Nest (enableShutdownHooks) — đóng socket, pool.
CMD ["node", "dist/main.js"]
