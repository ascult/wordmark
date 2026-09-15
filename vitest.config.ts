import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // content script 的 DOM 逻辑全部在 jsdom 下验证
    environment: 'jsdom',
    // 构建脚本是 .mjs（node 直接跑），纯函数部分用 .mjs 测试文件覆盖
    include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'],
    globals: false,
    restoreMocks: true,
  },
});
