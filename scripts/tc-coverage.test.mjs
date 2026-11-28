// Test của scripts/tc-coverage.mjs (T112). Chạy: node --test scripts/tc-coverage.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildReport,
  findCodes,
  main,
  normalizeCode,
  parseCsv,
  scanSource,
} from './tc-coverage.mjs';

const codes = (src, dart = false) =>
  scanSource(src, dart)
    .filter((o) => !o.skipped)
    .map((o) => o.code);
const skippedCodes = (src, dart = false) =>
  scanSource(src, dart)
    .filter((o) => o.skipped)
    .map((o) => o.code);

describe('regex và chuẩn hoá', () => {
  it('nhận đủ bốn họ mã, không nhận TC-F10-0x hay TC-BRP52-01', () => {
    const text = 'TC-F06-01 TC-WF03 TC-NFR-06 TC-STM1-9a TC-STM6-t1 TC-F10-0x TC-BRP52-01';
    assert.deepEqual(
      findCodes(text).map((c) => c.code),
      ['TC-F06-01', 'TC-WF03', 'TC-NFR-06', 'TC-STM1-9a', 'TC-STM6-t1'],
    );
  });

  it('bỏ t và số 0 đầu: TC-STM3-02 ≡ TC-STM3-2, TC-STM6-1 ≡ TC-STM6-t1', () => {
    assert.equal(normalizeCode('TC-STM3-02'), normalizeCode('TC-STM3-2'));
    assert.equal(normalizeCode('TC-STM6-1'), normalizeCode('TC-STM6-t1'));
    assert.equal(normalizeCode('TC-STM1-12a'), 'TC-STM1-12a');
    assert.notEqual(normalizeCode('TC-STM1-12a'), normalizeCode('TC-STM1-12'));
  });

  it('tách dạng gộp TC-STM4-12/13 thành hai mã', () => {
    assert.deepEqual(
      findCodes('TC-STM4-12/13: x').map((c) => c.code),
      ['TC-STM4-12', 'TC-STM4-13'],
    );
  });
});

describe('quét tên test (TS)', () => {
  it('chỉ lấy mã trong tên; comment, JSDoc, biến và assertion không tính', () => {
    const src = [
      '/** TC-F01-01 trong JSDoc */',
      "const label = 'TC-F01-02';",
      '// TC-F01-03 trong comment',
      "it('TC-F02-01 tên // không phải comment', () => {",
      "  expect(x).toBe('TC-F02-02'); /* TC-F02-03 */",
      '});',
      "describe('nhóm TC-F03-02', () => { test.concurrent('TC-F03-03 con', () => {}); });",
    ].join('\n');
    assert.deepEqual(codes(src), ['TC-F02-01', 'TC-F03-02', 'TC-F03-03']);
  });

  it('ghi đúng số dòng của mã', () => {
    const src = "/* a\n b */\n\nit(\n  'TC-F06-02 x',\n  () => {},\n);";
    assert.deepEqual(
      scanSource(src).map((o) => o.line),
      [5],
    );
  });

  it('.skip, .todo, xit và test trong describe.skip không tính, được trả riêng', () => {
    const src = [
      "it.skip('TC-F04-01 a', () => {});",
      "xit('TC-F04-02 b', () => {});",
      "it.todo('TC-F04-03 c');",
      "describe.skip('nhóm', () => { it('TC-F05-01 d', () => {}); });",
      "it('TC-F05-02 e', () => {});",
    ].join('\n');
    assert.deepEqual(codes(src), ['TC-F05-02']);
    assert.deepEqual(skippedCodes(src), ['TC-F04-01', 'TC-F04-02', 'TC-F04-03', 'TC-F05-01']);
  });

  it('alias theo DATABASE_URL / url tính; alias theo điều kiện khác thì như skip', () => {
    const src = [
      'const describeDb = DATABASE_URL ? describe : describe.skip;',
      'const run = config ? describe : describe.skip;',
      "describeDb('TC-F06-01 db', () => { it('TC-F06-02 trong db', () => {}); });",
      "run('live', () => { it('TC-F06-03 live', () => {}); });",
      "(url ? describe : describe.skip)('TC-F07-01 inline', () => {});",
      "(config ? describe : describe.skip)('TC-F07-03 inline live', () => {});",
    ].join('\n');
    assert.deepEqual(codes(src), ['TC-F06-01', 'TC-F06-02', 'TC-F07-01']);
    assert.deepEqual(skippedCodes(src), ['TC-F06-03', 'TC-F07-03']);
  });

  it('.each: mã trong bảng literal, bảng qua identifier và bảng có tham số kiểu', () => {
    const src = [
      "const ROWS: Row[] = [['1', 'a', 'TC-STM1-1 ghi chú'], ['2', 'b', 'TC-STM1-2']];",
      "it.each(ROWS)('#%s: %s (%s)', (_n, a) => {});",
      "it.each([['x', 'TC-STM2-01']])('%s → (%s)', () => {});",
      "it.each<[string, number]>([['TC-STM3-04 a', 1]])('%s', () => {});",
      "describe.each([{ note: 'TC-STM6-t2' }])('$note', () => {});",
    ].join('\n');
    assert.deepEqual(codes(src), [
      'TC-STM1-1',
      'TC-STM1-2',
      'TC-STM2-01',
      'TC-STM3-04',
      'TC-STM6-t2',
    ]);
  });

  it('.each mà tên không có placeholder thì mã trong bảng không vào tên', () => {
    const src = "it.each([['TC-F08-01']])('tên cố định', () => {});";
    assert.deepEqual(codes(src), []);
  });

  it('chuỗi chứa it( không bị coi là lời gọi test; regex literal có dấu nháy không làm lệch', () => {
    const src = [
      'const s = "it(\'TC-F08-02 giả\')";',
      "const re = /'/;",
      "it('TC-F08-03 thật', () => { expect(s).toMatch(/it\\(/); });",
    ].join('\n');
    assert.deepEqual(codes(src), ['TC-F08-03']);
  });
});

describe('quét tên test (Dart)', () => {
  it('test / testWidgets / group; skip: không tính; comment không tính', () => {
    const src = [
      '/// TC-F01-01 doc comment',
      "group('TC-F01-02 nhóm', () {",
      "  test('TC-F01-03 con', () {});",
      "  testWidgets('TC-F02-01 widget', (tester) async {}, skip: true);",
      "  test(r'TC-F02-02 raw', () { test('TC-F02-03', () {}, skip: true); });",
      '});',
      "test('''TC-F03-02 ba nháy''', () {});",
    ].join('\n');
    assert.deepEqual(codes(src, true), ['TC-F01-02', 'TC-F01-03', 'TC-F02-02', 'TC-F03-02']);
    assert.deepEqual(skippedCodes(src, true), ['TC-F02-01', 'TC-F02-03']);
  });
});

describe('báo cáo và --min', () => {
  const csv = [
    'id,sheet,owner,run,title',
    'TC-F01-01,Features,A,CI,"Một, hai"',
    'TC-F01-02,Features,B,Man,ba',
    'TC-STM6-t1,STM-6 Fault,B,CI,bốn',
  ].join('\n');

  it('parseCsv đọc trường có dấu phẩy trong ngoặc kép', () => {
    assert.equal(parseCsv(csv)[0].title, 'Một, hai');
  });

  it('đếm ca CI, tách ca Man có test và mã không có trong CSV', () => {
    const r = buildReport(parseCsv(csv), [
      { code: 'TC-STM6-1', file: 'a.spec.ts', line: 3, skipped: false },
      { code: 'TC-F01-02', file: 'a.spec.ts', line: 4, skipped: false },
      { code: 'TC-F09-09', file: 'a.spec.ts', line: 5, skipped: false },
      { code: 'TC-F01-01', file: 'a.spec.ts', line: 6, skipped: true },
    ]);
    assert.equal(r.covered, 1);
    assert.equal(r.ciTotal, 2);
    assert.deepEqual(r.byOwner.A, { covered: 0, total: 1, missing: ['TC-F01-01'] });
    assert.deepEqual(
      r.nonCiWithTests.map((c) => c.id),
      ['TC-F01-02'],
    );
    assert.deepEqual(r.unknown, { 'TC-F09-09': ['a.spec.ts:5'] });
    assert.deepEqual(r.skipped, [{ code: 'TC-F01-01', loc: 'a.spec.ts:6' }]);
  });

  it('main: --min trả 1 khi thiếu ca, 0 khi đủ', (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'tc-coverage-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, 'docs/testing'), { recursive: true });
    mkdirSync(path.join(root, 'apps/x/node_modules'), { recursive: true });
    writeFileSync(path.join(root, 'docs/testing/report5-test-cases.csv'), csv);
    writeFileSync(path.join(root, 'apps/x/a.spec.ts'), "it('TC-F01-01 a', () => {});");
    writeFileSync(path.join(root, 'apps/x/node_modules/b.spec.ts'), "it('TC-STM6-t1', () => {});");
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'error', () => {});
    delete process.env.GITHUB_STEP_SUMMARY;
    assert.equal(main(['--min', '2'], root), 1);
    assert.equal(main(['--min', '1'], root), 0);
    assert.equal(main([], root), 0);
  });
});
