// Vercel 서버리스 함수 진입점. apps/backend/src/app.ts 의 Express 앱을 그대로
// export한다 — Vercel의 Node 런타임이 (req, res) 요청마다 이 핸들러를 호출한다.
// 루트 vercel.json의 rewrites가 /game/* 요청을 이 함수로 보낸다.
import { app } from '../apps/backend/src/app';

export default app;
