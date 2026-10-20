import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['**/dist/**', '**/node_modules/**', 'playwright-report/**', 'test-results/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
            ],
        },
    },
    {
        files: ['server/**/*.ts', 'shared/**/*.ts', '*.ts'],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['deploy/**/*.mjs'],
        languageOptions: { globals: globals.node },
    },
    {
        files: ['frontend/public/**/*.js'],
        languageOptions: { globals: globals.browser },
    },
    {
        files: ['frontend/**/*.{ts,tsx}'],
        languageOptions: { globals: globals.browser },
        plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
        rules: {
            ...reactHooks.configs.recommended.rules,
            'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
            'no-console': ['warn', { allow: ['warn', 'error'] }],
        },
    },
    {
        files: ['**/*.test.{ts,tsx}', 'e2e/**/*.ts'],
        languageOptions: { globals: { ...globals.node, ...globals.browser } },
    },
    {
        files: ['frontend/src/theme/ThemeProvider.tsx'],
        rules: { 'react-refresh/only-export-components': 'off' },
    }
);
