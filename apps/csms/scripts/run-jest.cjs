// Chạy Jest với cờ --experimental-vm-modules.
//
// Vì sao tồn tại: @nestjs/common, @nestjs/core 12 và drizzle-orm là ESM-only. Mã CSMS build ra
// CommonJS và Node 24 require(esm) được tự nhiên, nhưng runtime module của Jest chỉ require(esm)
// được khi có vm.SourceTextModule — tức là cần cờ trên. Đặt NODE_OPTIONS trong npm script không
// chạy được trên Windows (cmd.exe), nên bọc bằng file này cho cả máy dev lẫn CI.
'use strict';

const { spawnSync } = require('node:child_process');

const result = spawnSync(
  process.execPath,
  ['--experimental-vm-modules', require.resolve('jest/bin/jest'), ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
