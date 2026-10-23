// Cấu hình Jest cho @powerme/csms (Iteration 1, BE-07).
//
// - Unit test (`src/**/*.spec.ts`) không cần DB.
// - Test tích hợp (`test/**/*.test.ts`) tự skip khi thiếu DATABASE_URL; trên CI có Postgres.
// - moduleNameMapper: mã nguồn import theo kiểu NodeNext (`./enums.js`) nhưng ts-jest chạy
//   file .ts, nên phải bỏ đuôi .js lúc resolve.

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  // Hai test tích hợp cùng DROP SCHEMA public trên một DATABASE_URL nên không được chạy song song.
  maxWorkers: 1,
  testTimeout: 120000,
};
