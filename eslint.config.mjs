import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';

/**
 * Package boundaries (SPEC §3): kernel ← review ← agent ← apps/server,
 * protocol ← apps/server and apps/web; Yjs stays inside kernel and the web editor.
 */
const forbid = (...names) => ({
  'no-restricted-imports': ['error', {
    patterns: [{ group: names.flatMap((name) => [name, `${name}/*`]), message: 'This import crosses a package boundary (SPEC §3).' }],
  }],
});

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', 'paper-pal/**'] },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mjs'],
    languageOptions: { parser, parserOptions: { sourceType: 'module' } },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  { files: ['packages/kernel/**'], rules: forbid('@collab/review', '@collab/agent', '@collab/protocol', '@collab/server', '@collab/web') },
  { files: ['packages/review/**'], rules: forbid('@collab/agent', '@collab/protocol', '@collab/server', '@collab/web', 'yjs') },
  { files: ['packages/agent/**'], rules: forbid('@collab/protocol', '@collab/server', '@collab/web', 'yjs') },
  { files: ['packages/protocol/**'], rules: forbid('@collab/kernel', '@collab/review', '@collab/agent', '@collab/server', '@collab/web', 'yjs') },
  { files: ['apps/server/src/**'], rules: forbid('@collab/web', 'yjs') },
  { files: ['apps/web/**'], rules: forbid('@collab/kernel', '@collab/review', '@collab/agent', '@collab/server') },
];
