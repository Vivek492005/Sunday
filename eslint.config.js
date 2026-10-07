// Minimal ESLint flat config for the Sunday product workspace.
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'vscode/**', 'landing/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  }
);
