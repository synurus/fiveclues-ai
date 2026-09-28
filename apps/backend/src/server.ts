/**
 * 로컬 개발용 진입점(npm run dev -w backend). Vercel 배포에선 안 쓰인다 —
 * 거긴 /api/index.ts 가 app.ts를 그대로 서버리스 함수로 노출한다(app.listen 없이).
 */

import { app } from './app';

// PORT가 아니라 API_PORT를 읽는다(2026-09-28) — PORT는 개발 도구가 웹(Vite) 서버용으로
// 채워 넘기는 경우가 있어서(미리보기 도구가 PORT=5173), API가 Vite와 같은 포트로 떠
// vite.config.ts의 /game 프록시(3000번)가 연결을 못 했다.
const PORT = Number(process.env.API_PORT || 3000);
app.listen(PORT, () => {
  console.log(`API http://localhost:${PORT}  (POST /game/start, POST /game/guess, POST /game/feedback)`);
});
