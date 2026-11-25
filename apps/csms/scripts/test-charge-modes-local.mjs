import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { startEmbeddedDb } from '../demo/db-embedded.mjs';

const mode = process.argv[2] ?? '--all-driver';
if (!['--all-driver', '--charges', '--wf01'].includes(mode))
  throw new Error('Expected --all-driver, --charges or --wf01');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node 24 or newer');

const listener = createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve, reject) =>
  listener.close((error) => (error ? reject(error) : resolve())),
);
const cluster = await startEmbeddedDb({
  port,
  dataDir: fileURLToPath(new URL(`../.cache/t96-charge-modes-${Date.now()}`, import.meta.url)),
  database: 't96_test_admin',
});
let status = 1;
try {
  // WP3: no inherited application/staging URL can reach a child test process.
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.MB03_TEST_DATABASE_URL;
  delete env.MB03_TEST_ADMIN_DATABASE_URL;
  delete env.MB03_ALLOW_CREATE_TEST_DATABASE;
  delete env.MB03_TEST_ALLOW_EMPTY_DATABASE;
  let args;
  if (mode === '--all-driver') {
    env.MB03_TEST_ADMIN_DATABASE_URL = cluster.url.replace('/t96_test_admin', '/postgres');
    env.MB03_ALLOW_CREATE_TEST_DATABASE = 'true';
    args = ['scripts/test-driver-discovery.mjs'];
  } else {
    if (mode === '--wf01') {
      env.DATABASE_URL = cluster.url.replace('/t96_test_admin', '/powerme_test');
    } else {
      const name = `powerme_mb03_driver_test_${Date.now()}_${randomBytes(4).toString('hex')}`;
      const client = new Client({ connectionString: cluster.url });
      try {
        await client.connect();
        await client.query(`CREATE DATABASE ${name}`);
      } finally {
        await client.end();
      }
      env.MB03_TEST_DATABASE_URL = cluster.url.replace('/t96_test_admin', `/${name}`);
      env.MB03_TEST_ALLOW_EMPTY_DATABASE = 'true';
    }
    args = [
      'scripts/run-jest.cjs',
      '--runInBand',
      '--runTestsByPath',
      mode === '--wf01'
        ? 'test/wf01-driver-charging.integration.test.ts'
        : 'test/driver-charges.integration.test.ts',
      ...process.argv.slice(3),
    ];
  }
  const child = spawn(process.execPath, args, {
    cwd: new URL('..', import.meta.url),
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  status = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
} finally {
  cluster.stopSync();
}
process.exit(status);
