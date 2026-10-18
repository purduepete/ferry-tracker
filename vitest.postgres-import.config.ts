import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@ferry-tracker/shared': path.resolve(__dirname, 'shared/src/index.ts') } },
  test: { environment: 'node', include: ['server/test/postgresImport.integration.ts'], testTimeout: 30000, fileParallelism: false },
});
