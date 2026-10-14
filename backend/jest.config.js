/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Default is one worker per CPU less one; on many-core hosts that runs out of memory.
  maxWorkers: '25%',
  workerIdleMemoryLimit: '512MB',
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/db/migrations/**',
    '!src/index.ts',
  ],
  coverageReporters: ['text', 'lcov'],
};
