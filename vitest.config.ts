import { defineConfig } from 'vitest/config';

// テストは crx プラグインを通さない (純粋ロジック + jsdom の単体テスト)。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
