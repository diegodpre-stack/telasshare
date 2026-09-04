import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  { ignores: ['dist', 'local-sfu/dist/**', 'local-sfu/runtime/**'] },
  {
    files: ['**/*.{js,jsx}'],
    // __BUILD_ID__ is substituted by Vite at build time, so it never exists as a real binding here.
    languageOptions: { ecmaVersion: 2022, globals: { ...globals.browser, ...globals.node, __BUILD_ID__: 'readonly' }, parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' } },
    plugins: { react, 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: { ...js.configs.recommended.rules, ...reactHooks.configs.recommended.rules, 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }], 'react/jsx-uses-vars': 'error', 'react-refresh/only-export-components': ['warn', { allowConstantExport: true }] },
  },
]
