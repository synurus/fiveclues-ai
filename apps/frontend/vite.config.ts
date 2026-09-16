import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/socket.io': { target: 'http://localhost:3000', ws: true },
      // 턴제 게임 API(apps/backend/src/turnServer.ts, 기본 3000번). 실시간 서버와
      // 포트가 같아도 된다 — 둘을 동시에 띄울 땐 TURN_PORT로 따로 지정할 것.
      '/game': { target: 'http://localhost:3000' },
    },
  },
});
