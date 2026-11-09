import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';

if (process.env.MB03_ALLOW_CREATE_TEST_DATABASE !== 'true')
  throw new Error('Set MB03_ALLOW_CREATE_TEST_DATABASE=true to create a dedicated test database');
let adminUrl;
try {
  adminUrl = new URL(process.env.MB03_TEST_ADMIN_DATABASE_URL ?? '');
} catch {
  throw new Error('Provide a valid private loopback admin connection; value suppressed');
}
if (!['127.0.0.1', '[::1]'].includes(adminUrl.hostname) || adminUrl.pathname !== '/postgres')
  throw new Error('Requires a loopback PostgreSQL admin connection to /postgres');
const suites = [
  'test/driver-discovery.integration.test.ts',
  'test/driver-smart.integration.test.ts',
  'test/driver-auth.integration.test.ts',
];
for (const suite of suites) {
  const name = `powerme_mb03_driver_test_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const client = new Client({ connectionString: adminUrl.toString() });
  try {
    await client.connect();
    await client.query(`CREATE DATABASE ${name}`);
  } catch {
    throw new Error('Cannot create isolated test database; credentials suppressed');
  } finally {
    await client.end();
  }
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${name}`;
  const env = {
    ...process.env,
    MB03_TEST_DATABASE_URL: testUrl.toString(),
    MB03_TEST_ALLOW_EMPTY_DATABASE: 'true',
  };
  // Each suite gets its own empty database, never the admin or local application database.
  delete env.DATABASE_URL;
  delete env.MB03_TEST_ADMIN_DATABASE_URL;
  const result = spawnSync(
    process.execPath,
    ['scripts/run-jest.cjs', '--runInBand', '--runTestsByPath', suite],
    { cwd: new URL('..', import.meta.url), env, stdio: 'inherit', windowsHide: true },
  );
  console.log(JSON.stringify({ suite, test_database: name, retained_for_review: true }));
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
