import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import tsconfigPaths from 'vite-tsconfig-paths';

// The `server-only` / `client-only` marker packages throw when imported outside
// the Next.js build. Alias them to an empty stub so tests can import the pure
// functions living in server modules (e.g. lib/cvent/client.ts).
const emptyModule = fileURLToPath(new URL('./test/empty-module.ts', import.meta.url));

// Look for sibling .test.ts files to run as tests
export default defineConfig({
    plugins: [tsconfigPaths()],
    resolve: {
        alias: {
            'server-only': emptyModule,
            'client-only': emptyModule,
        },
    },
    test: {
        include: ['**/*.test.ts'],
        setupFiles: ['./test/setup.ts'],
    },
});
