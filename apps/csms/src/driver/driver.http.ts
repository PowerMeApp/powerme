import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { Db } from '../db/db.module.js';
import type { DriverChargingService } from '../sessions/driver-charging.service.js';
import { ChargingError } from '../sessions/charging-error.js';
import type { StationSearchInput } from '../sessions/station-search.js';
import { DriverAccounts, DriverRateLimited } from './driver-account.js';
import { authenticateDriver, databaseId, DriverApiConfig, DriverApiError } from './driver-auth.js';
import {
  chargeRouteMethod,
  chargingErrorStatus,
  handleChargeRoute,
  isChargePath,
} from './charges.http.js';
import { handleRoad, isRoadPath } from './road.http.js';
import { RoadDiscovery } from './road-discovery.js';
import { ProviderUnavailable, VietmapAdapter } from './vietmap.js';

const BASE = '/api/driver/v1';
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
/** BE-21/BE-22: body JSON của /auth/* và POST /charges tối đa 16 KiB (refresh token ≤ 8192 ký tự, form đăng ký). */
const AUTH_BODY_LIMIT = 16 * 1024;
const AUTH_ROUTES = ['register', 'login', 'refresh'] as const;

export function createDriverListener(
  db: Db,
  service: DriverChargingService,
  config: DriverApiConfig,
  road = new RoadDiscovery(db, new VietmapAdapter(config.searchKey), undefined),
  accounts = new DriverAccounts(db, config),
): RequestListener {
  return (req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent)
        send(res, 500, { error: 'internal_error', detail: 'Lỗi nội bộ của CSMS' });
      else res.end();
    });
  };
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (origin && LOCAL_ORIGIN.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    try {
      if (origin && !LOCAL_ORIGIN.test(origin)) throw new DriverApiError(403, 'forbidden_origin');
      const authMatch = /^\/api\/driver\/v1\/auth\/([^/]*)$/.exec(
        new URL(req.url ?? '', 'http://driver.local').pathname,
      );
      if (authMatch) {
        await handleAuth(req, res, authMatch[1]!);
        return;
      }
      if (req.method === 'OPTIONS') {
        // BE-22: route POST của charges/sessions cần thêm Content-Type và Idempotency-Key.
        const write =
          chargeRouteMethod(new URL(req.url ?? '', 'http://driver.local').pathname) === 'POST';
        res.setHeader('Access-Control-Allow-Methods', write ? 'POST, OPTIONS' : 'GET, OPTIONS');
        const headers = config.devAuth ? 'Authorization, X-Driver-Id' : 'Authorization';
        res.setHeader(
          'Access-Control-Allow-Headers',
          write ? `${headers}, Content-Type, Idempotency-Key` : headers,
        );
        res.writeHead(204);
        res.end();
        return;
      }
      const driverId = await authenticateDriver(req, db, config);
      const url = new URL(req.url ?? '', 'http://driver.local');
      const q = url.searchParams;
      const path = url.pathname;
      if (isRoadPath(path)) {
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET, OPTIONS');
          throw new DriverApiError(405, 'method_not_allowed');
        }
        const controller = new AbortController();
        const cancel = () => {
          if (!res.writableEnded) controller.abort();
        };
        res.once('close', cancel);
        try {
          send(res, 200, await handleRoad(path, q, driverId, road, controller.signal));
        } finally {
          res.off('close', cancel);
        }
        return;
      }
      if (isChargePath(path)) {
        const result = await handleChargeRoute({
          req,
          path,
          q,
          driverId,
          db,
          service,
          readBody: () => readJsonObject(req, res),
          drainBody: () => drainBody(req, res),
          setAllow: (methods) => res.setHeader('Allow', methods),
        });
        send(res, result.status, result.body);
        return;
      }
      const connector = new RegExp(`^${BASE}/connectors/by-code/([^/]+)/([^/]+)$`).exec(path);
      if (path.startsWith(`${BASE}/connectors/by-code/`) && !connector)
        throw new DriverApiError(400, 'invalid_connector_reference');
      if (![`${BASE}/stations`, `${BASE}/me`].includes(path) && !connector)
        throw new DriverApiError(404, 'not_found');
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET, OPTIONS');
        throw new DriverApiError(405, 'method_not_allowed');
      }
      if (path === `${BASE}/me`) {
        only(q, []);
        const row = (
          await db.$client.query(
            `SELECT u.id::text AS user_id,u.full_name,u.role,u.account_status,
            coalesce((SELECT jsonb_agg(jsonb_build_object('vehicle_id',v.id::text,'plate_number',v.plate_number,
              'is_default',v.is_default,'vehicle_model_id',m.id::text,'brand',m.brand,'model_name',m.model_name,
              'connector_type',m.connector_type,'is_vinfast',m.is_vinfast,
              'battery_capacity_kwh',m.battery_capacity_kwh::float8,'rated_range_km',m.rated_range_km,
              'max_dc_kw',m.max_dc_kw::float8) ORDER BY v.is_default DESC,v.id)
              FROM vehicles v JOIN vehicle_models m ON m.id=v.vehicle_model_id WHERE v.driver_id=u.id),'[]'::jsonb) AS vehicles
           FROM users u JOIN drivers d ON d.user_id=u.id WHERE u.id=$1 AND u.role='driver' AND u.account_status='active'`,
            [driverId],
          )
        ).rows[0];
        if (!row) throw new DriverApiError(403, 'forbidden');
        send(res, 200, row);
        return;
      }
      if (connector) {
        only(q, ['vehicle_id']);
        let code: string;
        try {
          code = decodeURIComponent(connector[1]!);
        } catch {
          throw new DriverApiError(400, 'invalid_connector_reference');
        }
        if (/[\/\\\x00-\x1f\x7f]/.test(code) || !['1', '2'].includes(connector[2]!))
          throw new DriverApiError(400, 'invalid_connector_reference');
        send(
          res,
          200,
          await service.resolveConnector(
            driverId,
            databaseId(q.get('vehicle_id')),
            code,
            Number(connector[2]),
          ),
        );
        return;
      }
      only(q, [
        'vehicle_id',
        'q',
        'latitude',
        'longitude',
        'radius_km',
        'availability',
        'sort',
        'page',
        'page_size',
        'include_vinfast_only',
        'soc_percent',
        'target_soc_percent',
      ]);
      const vehicleId = databaseId(q.get('vehicle_id'));
      const input: StationSearchInput = {};
      if (q.has('q')) input.query = q.get('q')!;
      for (const [external, internal] of [
        ['latitude', 'latitude'],
        ['longitude', 'longitude'],
        ['radius_km', 'radiusKm'],
        ['page', 'page'],
        ['page_size', 'pageSize'],
        ['soc_percent', 'socPercent'],
        ['target_soc_percent', 'targetSocPercent'],
      ] as const) {
        if (q.has(external)) {
          const raw = q.get(external)!;
          if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) throw new DriverApiError(400, 'invalid_search');
          input[internal] = Number(raw);
        }
      }
      if (q.has('availability'))
        input.availability = q.get('availability') as StationSearchInput['availability'];
      if (q.has('sort')) input.sort = q.get('sort') as StationSearchInput['sort'];
      if (q.has('include_vinfast_only')) {
        const value = q.get('include_vinfast_only');
        if (value !== 'true' && value !== 'false') throw new DriverApiError(400, 'invalid_search');
        input.includeVinfastOnly = value === 'true';
      }
      const result = await service.findStations(driverId, vehicleId, input);
      send(res, 200, {
        items: result.items.map((station) => ({
          ...station,
          latitude: station.latitude === null ? null : Number(station.latitude),
          longitude: station.longitude === null ? null : Number(station.longitude),
          connectors: station.connectors.map((c) => ({
            ...c,
            max_power_kw: c.max_power_kw === null ? null : Number(c.max_power_kw),
            rated_power_kw: c.rated_power_kw === null ? null : Number(c.rated_power_kw),
          })),
        })),
        estimate: result.estimate,
        ...(result.smart_unavailable_reason
          ? { smart_unavailable_reason: result.smart_unavailable_reason }
          : {}),
        total: result.total,
        page: result.page,
        page_size: result.pageSize,
      });
    } catch (error) {
      if (error instanceof DriverApiError) {
        if (error.status === 429)
          res.setHeader(
            'Retry-After',
            String(error instanceof DriverRateLimited ? error.retryAfterS : 60),
          );
        if (error.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
        send(res, error.status, { error: error.code, detail: error.code });
        return;
      }
      if (error instanceof ProviderUnavailable) {
        send(res, 503, { error: 'provider_unavailable', detail: error.reason });
        return;
      }
      if (error instanceof ChargingError) {
        const status = chargingErrorStatus(error.code);
        send(res, status, {
          error: status === 500 ? 'internal_error' : error.code,
          detail: status === 500 ? 'Lỗi nội bộ của CSMS' : error.code,
        });
        return;
      }
      throw error;
    }
  }

  /**
   * BE-21: POST /auth/register | /auth/login | /auth/refresh — không cần bearer. Chỉ nhận
   * `application/json`, body tối đa AUTH_BODY_LIMIT, object JSON phẳng; lỗi theo mẫu DriverApiError.
   */
  async function handleAuth(req: IncomingMessage, res: ServerResponse, route: string) {
    if (!(AUTH_ROUTES as readonly string[]).includes(route))
      throw new DriverApiError(404, 'not_found');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      throw new DriverApiError(405, 'method_not_allowed');
    }
    if (new URL(req.url ?? '', 'http://driver.local').search)
      throw new DriverApiError(400, 'invalid_input');
    accounts.assertConfigured();
    const body = await readJsonObject(req, res);
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (route === 'register') send(res, 201, await accounts.register(body, ip));
    else if (route === 'login') send(res, 200, await accounts.login(body, ip));
    else send(res, 200, await accounts.refresh(body));
  }
}

async function readJsonObject(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\s*(;\s*charset=utf-8\s*)?$/i.test(type))
    throw new DriverApiError(415, 'unsupported_media_type');
  const declared = req.headers['content-length'];
  if (declared !== undefined && !(Number(declared) <= AUTH_BODY_LIMIT)) {
    // Không đọc phần thân quá cỡ; đóng kết nối sau khi trả lỗi.
    res.setHeader('Connection', 'close');
    throw new DriverApiError(413, 'payload_too_large');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > AUTH_BODY_LIMIT) {
      res.setHeader('Connection', 'close');
      throw new DriverApiError(413, 'payload_too_large');
    }
    chunks.push(chunk);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new DriverApiError(400, 'invalid_input');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new DriverApiError(400, 'invalid_input');
  return parsed as Record<string, unknown>;
}

/** BE-22: POST /sessions/{id}/stop không có body theo hợp đồng; bỏ phần thân nếu có, vẫn giới hạn cỡ. */
async function drainBody(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > AUTH_BODY_LIMIT) {
      res.setHeader('Connection', 'close');
      throw new DriverApiError(413, 'payload_too_large');
    }
  }
}

function only(q: URLSearchParams, allowed: string[]) {
  for (const key of q.keys())
    if (!allowed.includes(key) || q.getAll(key).length !== 1)
      throw new DriverApiError(400, 'invalid_input');
}

function send(res: ServerResponse, status: number, body: unknown) {
  const value = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(value),
  });
  res.end(value);
}
