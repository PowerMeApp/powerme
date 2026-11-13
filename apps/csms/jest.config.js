// Cấu hình Jest cho @powerme/csms (Iteration 1, BE-07).
//
// - Unit test (`src/**/*.spec.ts`) không cần DB.
// - Test tích hợp (`test/**/*.test.ts`) tự skip khi thiếu DATABASE_URL; trên CI có Postgres.
// - moduleNameMapper: mã nguồn import theo kiểu NodeNext (`./enums.js`) nhưng ts-jest chạy
//   file .ts, nên phải bỏ đuôi .js lúc resolve.
// - `lab/rq1/**/*.spec.mjs`: unit test của harness RQ1 (ESM thuần, không qua ts-jest; chạy được nhờ
//   cờ --experimental-vm-modules trong scripts/run-jest.cjs).
// - `lab/nfr03/**/*.spec.mjs`: unit test của dụng cụ đo NFR-03 (phân vị, ghép cặp CALL–CALLRESULT).

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test', '<rootDir>/lab/rq1', '<rootDir>/lab/nfr03'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts', '**/*.spec.mjs'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  // Hai test tích hợp cùng DROP SCHEMA public trên một DATABASE_URL nên không được chạy song song.
  maxWorkers: 1,
  testTimeout: 120000,
};
