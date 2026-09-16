/**
 * Express 앱 본체. app.listen()을 안 하는 이유는 하나다 — 이 파일이 두 군데서
 * 재사용된다: server.ts(로컬 개발, app.listen 호출)와 /api/index.ts(Vercel
 * 서버리스 함수, express 앱을 그대로 export해서 Vercel이 요청마다 호출).
 *
 * cors 패키지 대신 헤더를 직접 단다 — @types/cors 없이 이 정도 응답에 패키지
 * 하나를 더 끌어올 이유가 없어서다.
 */

import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { gameRouter } from './routes/game';

export const app = express();

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json());
app.use('/game', gameRouter);
