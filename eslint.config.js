import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  { ignores: ['dist'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: { ecmaVersion: 2022, globals: { ...globals.browser, ...globals.node }, parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' } },
    plugins: { react, 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: { ...js.configs.recommended.rules, ...reactHooks.configs.recommended.rules, 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }], 'react/jsx-uses-vars': 'error', 'react-refresh/only-export-components': ['warn', { allowConstantExport: true }] },
  },
]
