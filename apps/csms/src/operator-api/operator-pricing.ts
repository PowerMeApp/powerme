/**
 * FE-06 — screen 24 Pricing & Promotions (UC-OPS-06, UC-OPS-07, BR-P02) behind RolesGuard
 * `operator_staff`, always scoped to the caller's Operator (BR-P16; manager and technician alike,
 * contract N5):
 *   GET  /api/operator/v1/tariffs?at=YYYY-MM-DD  → TariffScheduleView {current, upcoming[]}
 *   PUT  /api/operator/v1/tariffs                → new schedule from `effective_from` (≥ today)
 *   GET  /api/operator/v1/promotions?active=&page=&page_size=  → PromotionPage
 *   POST /api/operator/v1/promotions             → 201 Promotion
 *   PATCH /api/operator/v1/promotions/{id}       → Promotion (not expired; code immutable)
 *   POST /api/operator/v1/promotions/{id}/deactivate → Promotion (ends it now)
 *
 * Tariffs are per Operator with 3 bands (DB `tariff_band`, contract §6 #3). A schedule is the set of
 * `tariff_periods` rows with one `effective_from`; it must cover 00:00–24:00 with no gap or overlap,
 * because settlement needs exactly one period at every instant. Rows of a schedule that has started
 * are never edited or deleted (`session_tariff_segments` points at them): a new schedule closes the
 * previous one (`effective_to` = day before) and replaces any schedule that has not started yet.
 * Promotions are stored only: settlement does not apply them yet (decision K6).
 * `Idempotency-Key` on PUT is accepted and not stored; the same PUT twice gives the same schedule.
 */
import type { PoolClient } from 'pg';
import type { Db } from '../db/db.module.js';
import { chargeTransaction } from '../sessions/charge-sql.js';
import { AuthError } from '../users/auth.js';
import { DEFAULT_PAGE_SIZE, intParam, MAX_PAGE, MAX_PAGE_SIZE } from './operator-faults.js';

const BANDS = ['off_peak', 'normal', 'peak'] as const;
type Band = (typeof BANDS)[number];
const START_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const END_RE = /^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Z0-9_-]{3,20}$/;
const ID_RE = /^[1-9][0-9]{0,18}$/;
/** Today in the Operator's time zone (all tariff dates are Asia/Ho_Chi_Minh). */
const TODAY_SQL = `(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

export type PricingRoute =
  | { kind: 'tariffs'; methods: readonly string[] }
  | { kind: 'promotions'; methods: readonly string[] }
  | { kind: 'promotion'; id: string; methods: readonly string[] }
  | { kind: 'deactivate'; id: string; methods: readonly string[] };

/** Matches `rest` (path after /api/operator/v1); null if it is not a pricing route. */
export function matchPricingRoute(rest: string): PricingRoute | null {
  if (rest === '/tariffs') return { kind: 'tariffs', methods: ['GET', 'PUT'] };
  if (rest === '/promotions') return { kind: 'promotions', methods: ['GET', 'POST'] };
  const m = /^\/promotions\/([^/]+)(\/deactivate)?$/.exec(rest);
  if (!m) return null;
  if (!ID_RE.test(m[1]!)) throw new AuthError(404, 'not_found');
  return m[2]
    ? { kind: 'deactivate', id: m[1]!, methods: ['POST'] }
    : { kind: 'promotion', id: m[1]!, methods: ['PATCH'] };
}

function invalid(): never {
  throw new AuthError(400, 'invalid_input');
}

/** Only these keys, each at most once. */
function onlyKeys(query: URLSearchParams, allowed: string[]) {
  const keys = [...query.keys()];
  if (keys.some((k) => !allowed.includes(k)) || new Set(keys).size !== keys.length) invalid();
}

export async function runPricingRoute(
  db: Db,
  operatorId: string,
  route: PricingRoute,
  method: string,
  query: URLSearchParams,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  if (route.kind === 'tariffs') {
    if (method === 'GET') {
      onlyKeys(query, ['at']);
      const at = query.get('at');
      if (at !== null && !validDate(at)) invalid();
      return { status: 200, body: await tariffView(db, operatorId, at) };
    }
    onlyKeys(query, []);
    return { status: 200, body: await putSchedule(db, operatorId, body!) };
  }
  if (route.kind === 'promotions') {
    if (method === 'GET') return { status: 200, body: await listPromotions(db, operatorId, query) };
    onlyKeys(query, []);
    return { status: 201, body: await createPromotion(db, operatorId, body!) };
  }
  onlyKeys(query, []);
  if (route.kind === 'promotion')
    return { status: 200, body: await patchPromotion(db, operatorId, route.id, body!) };
  return { status: 200, body: await deactivatePromotion(db, operatorId, route.id) };
}

// ---- Tariffs -----------------------------------------------------------------------------

interface PeriodRow {
  effective_from: string;
  effective_to: string | null;
  band: Band;
  time_start: string;
  time_end: string;
  price_per_kwh_vnd: string;
}

function validDate(v: string) {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const PERIODS_SQL = `SELECT to_char(effective_from,'YYYY-MM-DD') AS effective_from,
    to_char(effective_to,'YYYY-MM-DD') AS effective_to,band::text AS band,
    to_char(time_start,'HH24:MI') AS time_start,
    CASE WHEN time_end='24:00:00' THEN '24:00' ELSE to_char(time_end,'HH24:MI') END AS time_end,
    price_per_kwh_vnd::text AS price_per_kwh_vnd
  FROM tariff_periods WHERE operator_id=$1`;

/** Rows grouped into schedules, one per `effective_from`, periods by start time. */
function schedules(rows: PeriodRow[]) {
  const map = new Map<
    string,
    { effective_from: string; effective_to: string | null; periods: unknown[] }
  >();
  for (const r of rows) {
    let s = map.get(r.effective_from);
    if (!s) {
      s = { effective_from: r.effective_from, effective_to: r.effective_to, periods: [] };
      map.set(r.effective_from, s);
    }
    s.periods.push({
      band: r.band,
      time_start: r.time_start,
      time_end: r.time_end,
      price_per_kwh_vnd: Number(r.price_per_kwh_vnd),
    });
  }
  return [...map.values()];
}

/** The schedule in force on `at` (default today) and the ones that start later. */
async function tariffView(db: Db, operatorId: string, at: string | null) {
  const { rows } = await db.$client.query<PeriodRow & { on_date: string }>(
    `${PERIODS_SQL} AND (effective_to IS NULL OR effective_to >= coalesce($2::date, ${TODAY_SQL}))
     ORDER BY effective_from, time_start`,
    [operatorId, at],
  );
  const day = at ?? (await today(db.$client));
  const all = schedules(rows);
  const started = all.filter((s) => s.effective_from <= day);
  return {
    current: started.at(-1) ?? null,
    upcoming: all.filter((s) => s.effective_from > day),
  };
}

type Querier = Pick<PoolClient, 'query'>;

async function today(client: Querier) {
  return (await client.query<{ d: string }>(`SELECT to_char(${TODAY_SQL},'YYYY-MM-DD') AS d`))
    .rows[0]!.d;
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

interface PeriodInput {
  band: Band;
  time_start: string;
  time_end: string;
  price_per_kwh_vnd: number;
}

/** Body shape; coverage is checked separately (tariff_gap_or_overlap). */
function parseSchedule(body: Record<string, unknown>) {
  const keys = Object.keys(body);
  if (keys.some((k) => k !== 'effective_from' && k !== 'periods')) invalid();
  const from = body['effective_from'];
  const list = body['periods'];
  if (typeof from !== 'string' || !validDate(from)) invalid();
  if (!Array.isArray(list) || list.length < 1 || list.length > 24) invalid();
  const periods: PeriodInput[] = list.map((p: unknown) => {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) return invalid();
    const o = p as Record<string, unknown>;
    if (
      Object.keys(o).some(
        (k) => !['band', 'time_start', 'time_end', 'price_per_kwh_vnd'].includes(k),
      )
    )
      invalid();
    const { band, time_start, time_end, price_per_kwh_vnd: price } = o;
    if (
      !BANDS.includes(band as Band) ||
      typeof time_start !== 'string' ||
      !START_RE.test(time_start) ||
      typeof time_end !== 'string' ||
      !END_RE.test(time_end) ||
      typeof price !== 'number' ||
      !Number.isSafeInteger(price) ||
      price < 0
    )
      invalid();
    return { band: band as Band, time_start, time_end, price_per_kwh_vnd: price };
  });
  return { effective_from: from, periods };
}

/** BR-P02 / settlement: exactly one period at every minute of the day. */
export function coversDay(periods: { time_start: string; time_end: string }[]) {
  const sorted = [...periods].sort((a, b) => minutes(a.time_start) - minutes(b.time_start));
  let at = 0;
  for (const p of sorted) {
    const start = minutes(p.time_start);
    const end = minutes(p.time_end);
    if (start !== at || end <= start) return false;
    at = end;
  }
  return at === 24 * 60;
}

async function putSchedule(db: Db, operatorId: string, body: Record<string, unknown>) {
  const input = parseSchedule(body);
  if (!coversDay(input.periods)) throw new AuthError(400, 'tariff_gap_or_overlap');
  await chargeTransaction(db, async (client) => {
    // One schedule change per Operator at a time.
    await client.query('SELECT id FROM operators WHERE id=$1 FOR UPDATE', [operatorId]);
    const day = await today(client);
    if (input.effective_from < day) throw new AuthError(400, 'effective_from_in_past');
    // Schedules starting on or after the new date are replaced, unless a session already used one
    // (only possible for a schedule that started today).
    const used = await client.query(
      `SELECT 1 FROM tariff_periods tp JOIN session_tariff_segments sts ON sts.tariff_period_id=tp.id
       WHERE tp.operator_id=$1 AND tp.effective_from >= $2::date LIMIT 1`,
      [operatorId, input.effective_from],
    );
    if (used.rowCount) throw new AuthError(409, 'schedule_in_use');
    await client.query(
      'DELETE FROM tariff_periods WHERE operator_id=$1 AND effective_from >= $2::date',
      [operatorId, input.effective_from],
    );
    // The schedule still in force on the new date ends the day before.
    await client.query(
      `UPDATE tariff_periods SET effective_to = $2::date - 1, updated_at = now()
       WHERE operator_id=$1 AND effective_from < $2::date
         AND (effective_to IS NULL OR effective_to >= $2::date)`,
      [operatorId, input.effective_from],
    );
    for (const p of input.periods)
      await client.query(
        `INSERT INTO tariff_periods(operator_id,band,time_start,time_end,price_per_kwh_vnd,effective_from)
         VALUES($1,$2,$3::time,$4::time,$5,$6::date)`,
        [operatorId, p.band, p.time_start, p.time_end, p.price_per_kwh_vnd, input.effective_from],
      );
  });
  return tariffView(db, operatorId, null);
}

// ---- Promotions --------------------------------------------------------------------------

interface PromotionRow {
  id: string;
  promotion_code: string;
  discount_type: 'percent' | 'fixed_vnd';
  discount_value: string;
  valid_from: Date;
  valid_to: Date;
  active: boolean;
}

const PROMOTION_SQL = `SELECT id::text AS id,promotion_code,discount_type::text AS discount_type,
    discount_value::text AS discount_value,valid_from,valid_to,
    (valid_from <= now() AND now() < valid_to) AS active
  FROM promotions`;

function present(r: PromotionRow) {
  return {
    id: r.id,
    promotion_code: r.promotion_code,
    discount_type: r.discount_type,
    discount_value: Number(r.discount_value),
    valid_from: r.valid_from.toISOString(),
    valid_to: r.valid_to.toISOString(),
    active: r.active,
  };
}

async function listPromotions(db: Db, operatorId: string, query: URLSearchParams) {
  onlyKeys(query, ['active', 'page', 'page_size']);
  const active = query.get('active');
  const page = intParam(query.get('page'), 1);
  const pageSize = intParam(query.get('page_size'), DEFAULT_PAGE_SIZE);
  if (
    (active !== null && active !== 'true' && active !== 'false') ||
    !(page >= 1 && page <= MAX_PAGE) ||
    !(pageSize >= 1 && pageSize <= MAX_PAGE_SIZE)
  )
    invalid();
  const where = ` WHERE operator_id=$1 AND ($2::boolean IS NULL
    OR (valid_from <= now() AND now() < valid_to) = $2)`;
  const params = [operatorId, active === null ? null : active === 'true'];
  const [count, rows] = await Promise.all([
    db.$client.query<{ n: string }>('SELECT count(*)::text AS n FROM promotions' + where, params),
    db.$client.query<PromotionRow>(
      PROMOTION_SQL + where + ' ORDER BY valid_from DESC,id DESC LIMIT $3 OFFSET $4',
      [...params, pageSize, (page - 1) * pageSize],
    ),
  ]);
  return {
    items: rows.rows.map(present),
    total: Number(count.rows[0]!.n),
    page,
    page_size: pageSize,
  };
}

function timestamp(v: unknown): Date {
  if (typeof v !== 'string') return invalid();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? invalid() : d;
}

/** Type, value and validity: percent 0–100, fixed_vnd ≥ 0, valid_to after valid_from. */
function checkDiscount(type: unknown, value: unknown, from: Date, to: Date) {
  if (type !== 'percent' && type !== 'fixed_vnd') invalid();
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  if (type === 'percent' && value > 100) invalid();
  if (!(to.getTime() > from.getTime())) invalid();
}

async function createPromotion(db: Db, operatorId: string, body: Record<string, unknown>) {
  const allowed = ['promotion_code', 'discount_type', 'discount_value', 'valid_from', 'valid_to'];
  if (Object.keys(body).some((k) => !allowed.includes(k))) invalid();
  const code = body['promotion_code'];
  if (typeof code !== 'string' || !CODE_RE.test(code)) invalid();
  const from = timestamp(body['valid_from']);
  const to = timestamp(body['valid_to']);
  checkDiscount(body['discount_type'], body['discount_value'], from, to);
  try {
    const { rows } = await db.$client.query<{ id: string }>(
      `INSERT INTO promotions(promotion_code,operator_id,discount_type,discount_value,valid_from,valid_to)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text AS id`,
      [code, operatorId, body['discount_type'], body['discount_value'], from, to],
    );
    return readPromotion(db.$client, operatorId, rows[0]!.id);
  } catch (error) {
    if ((error as { constraint?: string }).constraint === 'promotions_promotion_code_key')
      throw new AuthError(409, 'promotion_code_taken');
    throw error;
  }
}

async function readPromotion(client: Querier, operatorId: string, id: string) {
  const row = (
    await client.query<PromotionRow>(PROMOTION_SQL + ' WHERE id=$1 AND operator_id=$2', [
      id,
      operatorId,
    ])
  ).rows[0];
  if (!row) throw new AuthError(404, 'not_found');
  return present(row);
}

/** A promotion of this Operator, locked; 404 otherwise, 409 when it has already ended. */
async function lockOpen(client: PoolClient, operatorId: string, id: string) {
  const row = (
    await client.query<PromotionRow & { ended: boolean }>(
      PROMOTION_SQL.replace('FROM promotions', ',(valid_to <= now()) AS ended FROM promotions') +
        ' WHERE id=$1 AND operator_id=$2 FOR UPDATE',
      [id, operatorId],
    )
  ).rows[0];
  if (!row) throw new AuthError(404, 'not_found');
  if (row.ended) throw new AuthError(409, 'promotion_expired');
  return row;
}

async function patchPromotion(
  db: Db,
  operatorId: string,
  id: string,
  body: Record<string, unknown>,
) {
  const allowed = ['discount_type', 'discount_value', 'valid_from', 'valid_to'];
  const keys = Object.keys(body);
  if (!keys.length || keys.some((k) => !allowed.includes(k))) invalid();
  return chargeTransaction(db, async (client) => {
    const cur = await lockOpen(client, operatorId, id);
    const type = body['discount_type'] ?? cur.discount_type;
    const value = body['discount_value'] ?? Number(cur.discount_value);
    const from = body['valid_from'] === undefined ? cur.valid_from : timestamp(body['valid_from']);
    const to = body['valid_to'] === undefined ? cur.valid_to : timestamp(body['valid_to']);
    checkDiscount(type, value, from, to);
    await client.query(
      `UPDATE promotions SET discount_type=$3,discount_value=$4,valid_from=$5,valid_to=$6,
         updated_at=now() WHERE id=$1 AND operator_id=$2`,
      [id, operatorId, type, value, from, to],
    );
    return readPromotion(client, operatorId, id);
  });
}

/** Ends the promotion now; one that has not started yet ends before it starts. */
async function deactivatePromotion(db: Db, operatorId: string, id: string) {
  return chargeTransaction(db, async (client) => {
    await lockOpen(client, operatorId, id);
    await client.query(
      `UPDATE promotions SET valid_from = least(valid_from, now() - interval '1 millisecond'),
         valid_to = now(), updated_at = now() WHERE id=$1 AND operator_id=$2`,
      [id, operatorId],
    );
    return readPromotion(client, operatorId, id);
  });
}
