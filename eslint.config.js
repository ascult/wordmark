import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      '.npm-cache/**',
      // 外部参考仓库与抓取缓存：里面是别人的构建产物，不该被本项目的规则扫
      '.tmp-ref/**',
      '.tmp-articles/**',
      // 一次性的草稿区（探针脚本、模型权重、缓存、截图）
      '.tmp-probe/**',
      '.tmp-shots/**',
      '.tmp-chrome/**',
      // 数据目录全是 JSON（且有单行大文件），没有可 lint 的源码
      'data/**',
      'src/data/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        chrome: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
