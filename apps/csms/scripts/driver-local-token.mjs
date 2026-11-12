import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { SignJWT } from 'jose';
import { loadDriverApiConfig } from '../dist/driver/driver-auth.js';

// WP3: local synthetic account bootstrap, not OTP/login or production token issuance.
if (process.env.NODE_ENV !== 'development' || process.env.DRIVER_API_ENV !== 'local')
  throw new Error('Requires development/local environment');
let database;
try {
  database = new URL(process.env.DATABASE_URL ?? '');
} catch {
  throw new Error('Provide a valid isolated local database connection; value suppressed');
}
if (
  database.hostname !== '127.0.0.1' ||
  database.port !== '54341' ||
  database.pathname !== '/powerme_mb03_baseline'
)
  throw new Error('Requires the isolated MB03 local database');
const output = process.argv[2];
if (!output || !path.isAbsolute(output))
  throw new Error('Provide an absolute token output file outside the repository');
const repo = path.resolve(import.meta.dirname, '../../..');
const relative = path.relative(repo, path.resolve(output));
if (!(relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)))
  throw new Error('Token output must be outside the repository');
const auth = loadDriverApiConfig(process.env);
if (!auth.secret || !auth.issuer || !auth.audience || auth.devAuth)
  throw new Error('Requires JWT config with dev auth disabled');
const client = new Client({ connectionString: database.toString() });
let seeded;
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query(
    "INSERT INTO users(email,full_name,role) VALUES('mb03-local-driver@example.invalid','MB03 Synthetic Local Driver','driver') ON CONFLICT(email) DO NOTHING",
  );
  const user = (
    await client.query(
      "SELECT id,role,account_status,full_name FROM users WHERE email='mb03-local-driver@example.invalid' FOR UPDATE",
    )
  ).rows[0];
  if (
    user.role !== 'driver' ||
    user.account_status !== 'active' ||
    user.full_name !== 'MB03 Synthetic Local Driver'
  )
    throw new Error('Existing account does not match synthetic local seed');
  await client.query(
    "INSERT INTO drivers(user_id,consent_version,consent_given_at) VALUES($1,'synthetic-local-v1',now()) ON CONFLICT(user_id) DO NOTHING",
    [user.id],
  );
  const subtype = (
    await client.query('SELECT consent_version FROM drivers WHERE user_id=$1', [user.id])
  ).rows[0];
  if (subtype.consent_version !== 'synthetic-local-v1')
    throw new Error('Existing subtype is not the synthetic local seed');
  await client.query(
    "INSERT INTO vehicle_models(brand,model_name,connector_type) VALUES('Synthetic','MB03 Local CCS2','ccs2') ON CONFLICT(brand,model_name) DO NOTHING",
  );
  const model = (
    await client.query(
      "SELECT id FROM vehicle_models WHERE brand='Synthetic' AND model_name='MB03 Local CCS2' AND connector_type='ccs2' AND NOT is_vinfast",
    )
  ).rows[0];
  if (!model) throw new Error('Existing vehicle model does not match local seed');
  await client.query(
    "INSERT INTO vehicles(driver_id,vehicle_model_id,plate_number,is_default) VALUES($1,$2,'MB03-LOCAL',true) ON CONFLICT DO NOTHING",
    [user.id, model.id],
  );
  const vehicle = (
    await client.query(
      "SELECT id,driver_id,vehicle_model_id FROM vehicles WHERE plate_number='MB03-LOCAL' AND removed_at IS NULL",
      [],
    )
  ).rows[0];
  if (vehicle.driver_id !== user.id || vehicle.vehicle_model_id !== model.id)
    throw new Error('Seed vehicle is owned by another account');
  seeded = { user_id: user.id, vehicle_id: vehicle.id };
  await client.query('COMMIT');
} catch {
  await client.query('ROLLBACK').catch(() => undefined);
  throw new Error('Local seed refused; no credentials logged');
} finally {
  await client.end().catch(() => undefined);
}
const now = Math.floor(Date.now() / 1000);
const token = await new SignJWT({ role: 'driver' })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .setSubject(seeded.user_id)
  .setIssuer(auth.issuer)
  .setAudience(auth.audience)
  .setIssuedAt(now)
  .setExpirationTime(now + 900)
  .setJti(randomUUID())
  .sign(auth.secret);
writeFileSync(output, token + '\n', { flag: 'wx', mode: 0o600 });
console.log(
  JSON.stringify({
    ...seeded,
    token_file: output,
    expires_at: new Date((now + 900) * 1000).toISOString(),
  }),
);
