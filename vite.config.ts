import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

// 拡張機能ビルド設定。テストは vitest.config.ts を参照する。
export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    target: 'es2022',
  },
});
