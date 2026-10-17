import { defineConfig } from 'eslint/config';
import globals from 'globals';
import base from './base.js';

/** NestJS / Node services. */
export default defineConfig([
  ...base,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
    },
    rules: {
      // Nest DI reads constructor parameter types at runtime (emitDecoratorMetadata),
      // so injected classes must be value imports, not `import type`.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
]);
