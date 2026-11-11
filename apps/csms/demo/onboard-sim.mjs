/**
 * DS-09 / DS-10 (WF-05, T119): onboard the seeded charge point SIM-0005 through the console HTTP
 * route and bring it into service with the returned credential — no ALLOW_LEGACY_NO_CREDENTIAL
 * involved, because SIM-0005 gets a credential at onboarding and a charge point with a credential
 * is always checked.
 *
 * Run while `npm run demo` is up (it sets CONSOLE_ACTOR_ADMIN_ID / CONSOLE_ACTOR_STAFF_ID):
 *   node apps/csms/demo/onboard-sim.mjs [--console http://127.0.0.1:3000] [--url ws://localhost:9000/ocpp]
 *                                       [--site-id N] [--hold-s 60] [--show-password]
 *
 * Steps:
 *   DS-10b  POST onboard for a serial that is NOT in the registry (SIM-9999) → expect 409
 *   DS-09a  POST /api/operator/charge-points/onboard for SIM-0005 → 201 {ocpp_url, identity, password}
 *   DS-10a  scripted-station ds-10: SIM-0005 with a wrong password → expect 401 (CSMS logs the rejection)
 *   DS-09b  scripted-station ds-09 with CP_PASSWORD = the returned password → Boot, connectors Available
 *   check   GET /api/admin/stations until SIM-0005 is in_service with 2 connectors Available
 *
 * The site id is read from the demo DB (site HCM-DEMO-01) unless --site-id is given. The password
 * is printed masked unless --show-password. Onboarding works once per charge point: to repeat the
 * demo, `npm run demo:reset -w @powerme/csms`.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const CONSOLE = opt('console', 'http://127.0.0.1:3000').replace(/\/+$/, '');
const OCPP_URL = opt('url', 'ws://localhost:9000/ocpp');
const HOLD_S = opt('hold-s', '60');
const SHOW = argv.includes('--show-password');
const SERIAL = 'SIM-0005';
const UNKNOWN_SERIAL = 'SIM-9999';

const log = (m) => console.log(`[ds-09] ${m}`);
const fail = (m) => {
  console.error(`[ds-09] ✗ ${m}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (p) => (SHOW ? p : `${p.slice(0, 4)}…(${p.length} chars, --show-password to print)`);

async function siteId() {
  const given = opt('site-id', null);
  if (given !== null) return Number(given);
  const pg = require('pg');
  const url =
    process.env.DATABASE_URL ??
    `postgresql://powerme:powerme@127.0.0.1:${process.env.DEMO_PG_PORT ?? 54330}/powerme_demo`;
  const client = new (pg.default ?? pg).Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT id FROM sites WHERE site_code = 'HCM-DEMO-01'`);
    if (!rows[0]) fail('site HCM-DEMO-01 not found — was demo/seed.sql loaded?');
    return Number(rows[0].id);
  } finally {
    await client.end();
  }
}

async function onboard(serialNumber, site) {
  const res = await fetch(`${CONSOLE}/api/operator/charge-points/onboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serial_number: serialNumber,
      site_id: site,
      connectors: [{ connector_no: 1 }, { connector_no: 2 }],
    }),
  });
  return { status: res.status, body: await res.json() };
}

function station(scenario, env, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        path.join(here, 'scripted-station.mjs'),
        scenario,
        '--id',
        SERIAL,
        '--url',
        OCPP_URL,
        ...extra,
      ],
      { stdio: 'inherit', env: { ...process.env, ...env } },
    );
    child.on('exit', (code) => resolve({ code }));
  });
}

async function main() {
  const site = await siteId();
  log(`console ${CONSOLE}, site HCM-DEMO-01 = id ${site}`);

  // DS-10b: unregistered serial → 409
  const unknown = await onboard(UNKNOWN_SERIAL, site);
  if (unknown.status === 503)
    fail(`console answered 503 ${unknown.body.error}: ${unknown.body.detail}`);
  if (unknown.status !== 409) fail(`expected 409 for ${UNKNOWN_SERIAL}, got ${unknown.status}`);
  log(`✓ DS-10 onboard ${UNKNOWN_SERIAL} (not in the registry) → 409 ${unknown.body.error}`);

  // DS-09a: onboard SIM-0005 → 201 + credential (shown once)
  const ok = await onboard(SERIAL, site);
  if (ok.status === 409 && ok.body.error === 'already_onboarded') {
    fail(
      `${SERIAL} is already onboarded; its password was shown once. Reset: npm run demo:reset -w @powerme/csms`,
    );
  }
  if (ok.status !== 201) fail(`onboard ${SERIAL} → ${ok.status} ${JSON.stringify(ok.body)}`);
  const { ocpp_url: ocppUrl, identity, password, display_code: displayCode, lifecycle } = ok.body;
  log(`✓ DS-09 onboard ${SERIAL} → 201 ${displayCode} ${lifecycle}`);
  log(`    ocpp_url ${ocppUrl}`);
  log(`    identity ${identity}`);
  log(`    password ${mask(password)}`);

  // DS-10a: wrong password → 401
  const wrong = await station('ds-10', { CP_PASSWORD: '' });
  if (wrong.code !== 0) fail('ds-10: the wrong password was not rejected with 401');
  log('✓ DS-10 wrong password → 401 (see the "từ chối SIM-0005 … 401" line in the [csms] log)');

  // DS-09b: right password → in_service, connectors Available
  const run = station('ds-09', { CP_PASSWORD: password }, ['--hold-s', HOLD_S]);
  const deadline = Date.now() + 20_000;
  let seen = null;
  while (Date.now() < deadline) {
    await sleep(500);
    const res = await fetch(`${CONSOLE}/api/admin/stations`).catch(() => null);
    if (!res?.ok) continue;
    seen = (await res.json()).find((s) => s.serial === SERIAL) ?? null;
    if (
      seen?.lifecycle === 'in_service' &&
      seen.connectors.length === 2 &&
      seen.connectors.every((c) => c.status === 'Available')
    )
      break;
  }
  if (seen?.lifecycle !== 'in_service')
    fail(`${SERIAL} did not reach in_service: ${JSON.stringify(seen)}`);
  log(
    `✓ DS-09 ${SERIAL}: awaiting_connection → in_service, connectors ${seen.connectors.map((c) => `${c.connector_no}=${c.status}`).join(', ')}`,
  );
  log(`staying online ${HOLD_S} s; Ctrl+C to stop`);
  const { code } = await run;
  process.exit(code ?? 0);
}

main().catch((err) => fail(err?.stack ?? String(err)));
