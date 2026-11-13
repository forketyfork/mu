import js from '@eslint/js';
import globals from 'globals';
import n from 'eslint-plugin-n';
import tseslint from 'typescript-eslint';

// Rules are chosen for the bugs they catch; formatting belongs to Prettier.
export default tseslint.config(
  { ignores: ['node_modules/', '.mu/', '.tmp/'] },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tseslint.parser,
      // Type information from tsconfig.json powers the promise rules below.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  js.configs.recommended,
  {
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      // A rejected promise nobody awaits becomes an unhandled rejection, which ends a Node process.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] },
          ],
        },
      ],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      'array-callback-return': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-constructor-return': 'error',
      'no-new-wrappers': 'error',
      'no-self-compare': 'error',
      'no-sequences': 'error',
      'no-template-curly-in-string': 'error',
      'no-throw-literal': 'error',
      'no-unreachable-loop': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-useless-concat': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      radix: 'error',
    },
  },
  {
    files: ['src/**', 'scripts/**', 'tests/**', '*.mjs'],
    ...n.configs['flat/recommended-module'],
    languageOptions: { ...n.configs['flat/recommended-module'].languageOptions, globals: globals.node },
    rules: {
      ...n.configs['flat/recommended-module'].rules,
      // node:sqlite is a release candidate in the Node.js 24 that Mu requires.
      'n/no-unsupported-features/node-builtins': ['error', { allowExperimental: true }],
      // The CLI, the service and the npm scripts end with an exit code on purpose; launchd reads the service's.
      'n/no-process-exit': 'off',
    },
  },
  {
    files: ['public/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    // An async request handler in a test fake that throws fails the run as an unhandled rejection, which is the report wanted.
    files: ['tests/**'],
    rules: { '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }] },
  },
  {
    // These tests feed shell syntax such as ${y//;/,} to the command parser.
    files: ['tests/tools.test.mjs'],
    rules: { 'no-template-curly-in-string': 'off' },
  },
);
