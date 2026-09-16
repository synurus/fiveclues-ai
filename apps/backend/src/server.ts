/**
 * 로컬 개발용 진입점(npm run dev -w backend). Vercel 배포에선 안 쓰인다 —
 * 거긴 /api/index.ts 가 app.ts를 그대로 서버리스 함수로 노출한다(app.listen 없이).
 */

import { app } from './app';

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`API http://localhost:${PORT}  (POST /game/start, POST /game/guess, POST /game/feedback)`);
});
