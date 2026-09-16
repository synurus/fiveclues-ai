import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 턴제 게임 API(apps/backend/src/server.ts, 기본 3000번). Vercel 배포에서는
      // /game/* 요청이 vercel.json의 rewrites로 서버리스 함수(api/index.ts)로
      // 바로 가므로 이 프록시가 필요 없다 — 로컬 개발(vite dev + npm run dev:api)
      // 전용이다.
      '/game': { target: 'http://localhost:3000' },
    },
  },
});
