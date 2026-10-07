import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開発時(npm run dev:client)は /api をローカルのサーバ(既定 8080)へ転送する
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    // エディタ(CodeMirrorの言語定義を含む)が大きいため、警告の閾値を引き上げる
    chunkSizeWarningLimit: 6000,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
});
