import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Look for sibling .test.ts files to run as tests
export default defineConfig({
    plugins: [tsconfigPaths()],
    test: {
        include: ['**/*.test.ts'],
    },
});
