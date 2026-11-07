import type { PoolClient } from 'pg';
import type { Db } from '../db/db.module.js';

// WP3/T31: RPC calls stay outside transactions so inbound evidence never waits on its caller.
export async function chargeTransaction<T>(
  db: Db,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.$client.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
