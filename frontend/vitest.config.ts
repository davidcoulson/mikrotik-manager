import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Default is one worker per CPU less one; on many-core hosts that runs out of memory.
    maxWorkers: '25%',
    include: ['src/**/*.test.ts'],
  },
});
