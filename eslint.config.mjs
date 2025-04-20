import { dirname } from 'path'
import { fileURLToPath } from 'url'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const compat = new FlatCompat({
  baseDirectory: __dirname,
})

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // '@typescript-eslint/no-unused-vars' ルールの設定を調整
      '@typescript-eslint/no-unused-vars': [
        'warn', // または 'error' (プロジェクトのルールに合わせてください)
        {
          argsIgnorePattern: '^_', // アンダースコアで始まる「引数」を無視
          varsIgnorePattern: '^_', // アンダースコアで始まる「変数」を無視
          caughtErrorsIgnorePattern: '^_', // catch句のエラー変数も無視 (任意)
        },
      ],
    },
  },
]

export default eslintConfig
