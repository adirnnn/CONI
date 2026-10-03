import { defineConfig } from 'vitest/config';

// Integration test files share one PostgreSQL test database; run them serially.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000 } });
