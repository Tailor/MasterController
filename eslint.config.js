import js from '@eslint/js';
import globals from 'globals';

// Flat config (ESLint 9). Correctness + security rules only — all
// formatting (indent, quotes, semicolons, spacing) is owned by Prettier
// (prettier.config.js). ESLint 9 removed the stylistic rules from core,
// so the old .eslintrc.json formatting rules now live in Prettier.
export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.node,
            },
        },
        rules: {
            'no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_',
            }],
            'no-console': 'off',
            'no-prototype-builtins': 'off',
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-var': 'warn',
            'prefer-const': 'warn',
            'no-throw-literal': 'error',
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
            'no-new-wrappers': 'error',
            'no-return-await': 'error',
            'require-await': 'warn',
        },
    },
    {
        ignores: ['node_modules/**', 'coverage/**', 'dist/**', 'build/**', '**/*.min.js'],
    },
];
