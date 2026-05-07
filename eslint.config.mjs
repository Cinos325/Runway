// ESLint 9+ flat config.
// Docs: https://eslint.org/docs/latest/use/configure/configuration-files

export default [
    {
        files: ['server.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                // Node.js globals used by server.js
                process: 'readonly',
                console: 'readonly',
                require: 'readonly',
                module: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                Buffer: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-undef': 'error',
            'no-var': 'warn',
            'prefer-const': 'warn',
            'eqeqeq': ['warn', 'smart'],
            'semi': ['warn', 'always'],
        },
    },
    {
        files: ['public/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                // Browser globals used by public/app.js
                window: 'readonly',
                document: 'readonly',
                fetch: 'readonly',
                console: 'readonly',
                alert: 'readonly',
                confirm: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                clearInterval: 'readonly',
                FormData: 'readonly',
                URLSearchParams: 'readonly',
                Promise: 'readonly',
                Date: 'readonly',
            },
        },
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            'no-undef': 'error',
            'no-var': 'warn',
            'prefer-const': 'warn',
            'eqeqeq': ['warn', 'smart'],
            'semi': ['warn', 'always'],
        },
    },
];