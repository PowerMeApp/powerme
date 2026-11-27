import type { PoolClient } from 'pg';
import type { Db } from '../db/db.module.js';
import { chargeTransaction } from '../sessions/charge-sql.js';
import { AuthError } from '../users/auth.js';
import { DEFAULT_PAGE_SIZE, intParam, MAX_PAGE, MAX_PAGE_SIZE } from './operator-faults.js';

type CardKind = 'online' | 'free_vend';
type CardStatus = 'unlinked' | 'active' | 'blocked';
interface CardRow {
  id: string;
  card_identifier: string;
  card_kind: CardKind;
  status: CardStatus;
  driver_id: string | null;
  email: string | null;
  full_name: string | null;
  issued_at: Date;
  updated_at: Date;
}

const ROOT = '/api/admin/v1/rfid-cards';
const SELECT_CARD = `SELECT c.id::text AS id,c.card_identifier,c.card_kind,c.status,
  d.user_id::text AS driver_id,u.email,u.full_name,c.issued_at,c.updated_at
  FROM rfid_cards c LEFT JOIN drivers d ON d.user_id=c.driver_id
  LEFT JOIN users u ON u.id=d.user_id`;

// WP3/T146: claim malformed child paths too, so RolesGuard precedes all RFID validation.
export function matchRfidRoute(pathname: string) {
  if (pathname !== ROOT && !pathname.startsWith(ROOT + '/')) return null;
  return {
    cardId: pathname === ROOT ? null : pathname.slice(ROOT.length + 1),
    methods: pathname === ROOT ? ['GET', 'POST'] : ['PATCH'],
  };
}

function invalid(): never {
  throw new AuthError(400, 'invalid_input');
}

function id(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return invalid();
  return value;
}

function tag(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    [...value].length > 20 ||
    /[\p{Cc}\p{Cs}]/u.test(value)
  )
    return invalid();
  return value;
}

function present(row: CardRow) {
  return {
    id: row.id,
    card_identifier: row.card_identifier,
    card_kind: row.card_kind,
    status: row.status,
    driver: row.driver_id
      ? { id: row.driver_id, email: row.email, full_name: row.full_name }
      : null,
    issued_at: row.issued_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function requireDriver(client: PoolClient, driverId: string | null) {
  if (driverId === null) return;
  const result = await client.query(
    `SELECT d.user_id FROM drivers d JOIN users u ON u.id=d.user_id
     WHERE d.user_id=$1 AND u.role='driver' FOR KEY SHARE OF d,u`,
    [driverId],
  );
  if (!result.rowCount) throw new AuthError(404, 'driver_not_found');
}

async function readCard(client: PoolClient, cardId: string) {
  const row = (await client.query<CardRow>(SELECT_CARD + ' WHERE c.id=$1', [cardId])).rows[0];
  if (!row) throw new AuthError(404, 'not_found');
  return present(row);
}

export async function runRfidRoute(
  db: Db,
  cardId: string | null,
  method: string,
  query: URLSearchParams,
  body?: Record<string, unknown>,
) {
  if (cardId !== null) id(cardId);
  if (method === 'GET') return { status: 200, body: await listCards(db, query) };
  if ([...query.keys()].length || !body) return invalid();
  const keys = Object.keys(body);
  const allowed =
    cardId === null ? ['card_identifier', 'card_kind', 'driver_id'] : ['driver_id', 'status'];
  if (!keys.length || keys.some((key) => !allowed.includes(key))) return invalid();
  const driverId =
    body['driver_id'] === undefined
      ? undefined
      : body['driver_id'] === null
        ? null
        : id(body['driver_id']);
  if (cardId === null) {
    const identifier = tag(body['card_identifier']);
    const kind = body['card_kind'];
    if (kind !== 'online' && kind !== 'free_vend') return invalid();
    if (kind === 'free_vend' && driverId != null)
      throw new AuthError(409, 'card_kind_has_no_driver');
    try {
      const card = await chargeTransaction(db, async (client) => {
        await requireDriver(client, driverId ?? null);
        const row = (
          await client.query<{ id: string }>(
            `INSERT INTO rfid_cards(card_identifier,card_kind,driver_id,status)
             VALUES($1,$2,$3,$4) RETURNING id::text AS id`,
            [
              identifier,
              kind,
              driverId ?? null,
              kind === 'free_vend' || driverId ? 'active' : 'unlinked',
            ],
          )
        ).rows[0]!;
        return readCard(client, row.id);
      });
      return { status: 201, body: card };
    } catch (error) {
      if (
        (error as { code?: string }).code === '23505' &&
        (error as { constraint?: string }).constraint === 'rfid_cards_card_identifier_key'
      )
        throw new AuthError(409, 'card_already_registered');
      throw error;
    }
  }
  const requested = body['status'];
  if (requested !== undefined && requested !== 'active' && requested !== 'blocked')
    return invalid();
  const card = await chargeTransaction(db, async (client) => {
    const current = (
      await client.query<{ card_kind: CardKind; status: CardStatus; driver_id: string | null }>(
        'SELECT card_kind,status,driver_id::text AS driver_id FROM rfid_cards WHERE id=$1 FOR UPDATE',
        [cardId],
      )
    ).rows[0];
    if (!current) throw new AuthError(404, 'not_found');
    const nextDriver = driverId === undefined ? current.driver_id : driverId;
    if (current.card_kind === 'free_vend' && nextDriver !== null)
      throw new AuthError(409, 'card_kind_has_no_driver');
    await requireDriver(client, nextDriver);
    if (requested === 'active' && current.card_kind === 'online' && nextDriver === null)
      return invalid();
    // WP3/T146: reassignment/unlink never clears a block; only explicit active unblocks.
    const status =
      requested ??
      (current.status === 'blocked'
        ? 'blocked'
        : current.card_kind === 'free_vend' || nextDriver !== null
          ? 'active'
          : 'unlinked');
    await client.query(
      'UPDATE rfid_cards SET driver_id=$2,status=$3,updated_at=clock_timestamp() WHERE id=$1',
      [cardId, nextDriver, status],
    );
    return readCard(client, cardId);
  });
  return { status: 200, body: card };
}

async function listCards(db: Db, query: URLSearchParams) {
  const keys = [...query.keys()];
  if (
    keys.some(
      (key) => !['card_kind', 'status', 'driver_id', 'q', 'page', 'page_size'].includes(key),
    ) ||
    new Set(keys).size !== keys.length
  )
    return invalid();
  const kind = query.get('card_kind');
  const status = query.get('status');
  const driverId = query.has('driver_id') ? id(query.get('driver_id')) : null;
  const prefix = query.has('q') ? tag(query.get('q')) : null;
  const page = intParam(query.get('page'), 1);
  const pageSize = intParam(query.get('page_size'), DEFAULT_PAGE_SIZE);
  if (
    (kind !== null && !['online', 'free_vend'].includes(kind)) ||
    (status !== null && !['unlinked', 'active', 'blocked'].includes(status)) ||
    !(page >= 1 && page <= MAX_PAGE) ||
    !(pageSize >= 1 && pageSize <= MAX_PAGE_SIZE)
  )
    return invalid();
  const params = [
    kind,
    status,
    driverId,
    prefix === null ? null : prefix.replace(/[\\%_]/g, '\\$&') + '%',
  ];
  const where = ` WHERE ($1::text IS NULL OR c.card_kind::text=$1)
    AND ($2::text IS NULL OR c.status::text=$2) AND ($3::bigint IS NULL OR c.driver_id=$3)
    AND ($4::text IS NULL OR c.card_identifier LIKE $4 ESCAPE E'\\\\')`;
  return chargeTransaction(db, async (client) => {
    // WP3/T146: total and items share one snapshot, including empty/out-of-range pages.
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const total = Number(
      (
        await client.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM rfid_cards c' + where,
          params,
        )
      ).rows[0]!.n,
    );
    const rows = (
      await client.query<CardRow>(SELECT_CARD + where + ' ORDER BY c.id DESC LIMIT $5 OFFSET $6', [
        ...params,
        pageSize,
        (page - 1) * pageSize,
      ])
    ).rows;
    return { items: rows.map(present), total, page, page_size: pageSize };
  });
}
