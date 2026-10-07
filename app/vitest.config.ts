import { defineConfig } from 'vitest/config';

// すべてNode環境で実行する。PDF/エディタの統合テスト(tests/)は実Chromiumを使うため、
// Dockerのtestステージ(またはChromium導入済みの環境)で実行する
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
