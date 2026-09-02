import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@ferry-tracker/shared': path.resolve(__dirname, 'shared/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['shared/test/**/*.test.ts', 'server/test/**/*.test.ts', 'frontend/test/**/*.test.tsx'],
    setupFiles: ['frontend/test/setup.ts'],
  },
});