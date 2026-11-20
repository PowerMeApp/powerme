import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const folder = new URL('./evidence/t139-20261120-b71120/', import.meta.url);
const read = (name) => readFileSync(new URL(name, folder));
const result = JSON.parse(read('result.json'));
const manifest = JSON.parse(read('manifest.json'));
const raw = read('samples.jsonl');
const points = JSON.parse(readFileSync(new URL('./road-points.json', import.meta.url)));
function verify(result, manifest, raw) {
  const samples = raw.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  assert.equal(createHash('sha256').update(raw).digest('hex'), result.provenance.samples_sha256);
  assert.equal(raw.length, result.provenance.samples_bytes);
  assert.equal(result.runid, manifest.runid);
  assert.equal(manifest.runid, 'b71120');
  assert.equal(manifest.state, 'cleaned');
  assert.equal(manifest.stations.length, 50);
  assert.equal(samples.length, 21);
  for (const key of ['site_id', 'cp_id', 'connector_id', 'osm_id']) {
    assert.equal(new Set(manifest.stations.map((s) => s[key])).size, 50);
  }
  manifest.stations.forEach((s, i) => {
    assert.deepEqual([s.osm_id, s.latitude, s.longitude], points.stations[i]);
  });
  const ids = new Set(manifest.stations.map((s) => s.site_id));
  const seen = new Map();
  const classes = {},
    sources = {};
  let roads = 0;
  samples.forEach((s, i) => {
    assert.equal(s.index, i);
    assert.equal(s.phase, i === 0 ? 'cold_pilot' : 'batch');
    assert.equal(s.status, 200);
    assert.ok(!s.error && Number.isFinite(s.elapsed_ms) && s.elapsed_ms >= 0);
    assert.equal(s.candidate_count, 50);
    assert.equal(s.items.length, 50);
    assert.deepEqual(new Set(s.items.map((x) => x.site_id)), ids);
    let count = 0,
      reused = 0;
    for (const item of s.items) {
      assert.match(item.site_id, /^[1-9]\d*$/);
      assert.ok(Object.hasOwn(item, 'road_estimate'));
      if (item.road_estimate === null) continue;
      const r = item.road_estimate;
      assert.ok(Number.isFinite(r.distance_m) && r.distance_m >= 0);
      assert.ok(Number.isInteger(r.duration_s) && r.duration_s >= 0);
      assert.ok(typeof r.computed_at === 'string' && Number.isFinite(Date.parse(r.computed_at)));
      count++;
      roads++;
      reused += Number(seen.get(item.site_id) === r.computed_at);
      seen.set(item.site_id, r.computed_at);
    }
    assert.equal(s.route_count, count);
    assert.ok(['brief', 'vietmap_route'].includes(s.ranking_source));
    assert.equal(count, s.ranking_source === 'brief' ? 0 : 6);
    assert.equal(s.reused_road_estimates, reused);
    let cache = reused === 6 ? 'warm_observed' : 'refreshed_estimates_observed';
    if (i === 0) cache = 'cold_new_principal';
    if (s.ranking_source === 'brief') cache = 'fallback';
    assert.equal(s.cache_class, cache);
    classes[cache] = (classes[cache] ?? 0) + 1;
    sources[s.ranking_source] = (sources[s.ranking_source] ?? 0) + 1;
    assert.ok(Number.isFinite(Date.parse(s.started_at)));
    if (i) assert.ok(Date.parse(s.started_at) - Date.parse(samples[i - 1].started_at) >= 12500);
  });
  function metrics(rows) {
    const n = rows.length;
    const sorted = rows.map((s) => s.elapsed_ms).sort((a, b) => a - b);
    const brief = rows.filter((s) => s.ranking_source === 'brief').length;
    return {
      n,
      p50_ms: sorted[Math.ceil(n * 0.5) - 1],
      p95_ms: sorted[Math.ceil(n * 0.95) - 1],
      max_ms: sorted.at(-1),
      brief_count: brief,
      brief_ratio: brief / n,
      six_road_samples: rows.filter((s) => s.route_count === 6).length,
    };
  }
  const groups = { primary: samples, cold_pilot: samples.slice(0, 1), batch: samples.slice(1) };
  for (const [name, rows] of Object.entries(groups)) {
    for (const [key, value] of Object.entries(metrics(rows))) {
      assert.equal(result.performance[name][key], value);
    }
  }
  assert.deepEqual(result.performance.cache_class_counts, classes);
  assert.deepEqual(result.performance.ranking_source_counts, sources);
  assert.equal(result.per_station_evidence.non_null_road_estimates, roads);
  assert.equal(result.per_station_evidence.null_road_estimates, 1050 - roads);
  const last = samples.at(-1),
    primary = result.performance.primary;
  assert.equal(last.ranking_source, 'brief');
  assert.equal(last.elapsed_ms, primary.max_ms);
  assert.equal(result.performance.last_sample.elapsed_ms, last.elapsed_ms);
  assert.equal(result.performance.last_sample.included_in_primary, true);
  assert.equal(primary.pass, primary.p95_ms <= 2000 && primary.six_road_samples > 0);
  assert.equal(Object.keys(manifest.baseline_counts).length, 17);
  assert.deepEqual(manifest.baseline_counts, manifest.final_counts);
  assert.deepEqual(result.cleanup.baseline_counts, manifest.baseline_counts);
  assert.deepEqual(result.cleanup.final_counts, manifest.final_counts);
  assert.equal(result.cleanup.manifest_state, 'cleaned');
  assert.equal(result.cleanup.recorded_postrun_exact_id_check.absent_station_rows, 152);
  assert.equal(result.cleanup.recorded_postrun_exact_id_check.absent_auth_rows, 3);
  return metrics(samples);
}

const verified = verify(result, manifest, raw);
if (process.argv.includes('--self-test')) {
  const cases = [
    (r, m, s) => s.pop(),
    (r, m, s) => {
      s[0].items[1] = s[0].items[0];
    },
    (r, m, s) => {
      s[0].items[0].road_estimate.distance_m = '100';
    },
    (r, m, s) => {
      s[1].started_at = s[0].started_at;
    },
    (r, m, s) => {
      s[1].cache_class = 'fallback';
    },
    (r, m, s) => {
      s[20].ranking_source = 'vietmap_route';
    },
    (r) => {
      r.performance.primary.p95_ms++;
    },
    (r, m) => {
      m.state = 'seeded';
    },
    (r, m) => {
      m.final_counts.sites = '64';
    },
    (r) => {
      r.provenance.samples_sha256 = '0'.repeat(64);
    },
  ];
  cases.forEach((mutate, i) => {
    const r = structuredClone(result),
      m = structuredClone(manifest);
    const rows = raw.toString('utf8').trimEnd().split('\n').map(JSON.parse);
    mutate(r, m, rows);
    const bytes = Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    if (i !== cases.length - 1)
      r.provenance.samples_sha256 = createHash('sha256').update(bytes).digest('hex');
    r.provenance.samples_bytes = bytes.length;
    assert.throws(() => verify(r, m, bytes));
  });
  console.log('Offline negative checks passed: 10');
}
console.log(JSON.stringify({ offline_evidence_verified: true, ...verified }));
