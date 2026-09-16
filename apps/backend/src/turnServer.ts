/**
 * 턴제 게임 서버 진입점. 기존 index.ts(실시간 socket.io, 옛 팀 버전)와는 별도
 * 파일이다 — 새 설계엔 다른 플레이어·토론이 없어 실시간이 필요 없다고
 * 판단했다(2026-09-15). index.ts를 실제로 걷어낼지는 아직 따로 정한 적 없어서
 * 지금은 나란히 둔다.
 *
 * cors 패키지 대신 헤더를 직접 단다 — package.json에 @types/cors가 없고, 이
 * 정도 응답에 패키지 하나를 더 끌어올 이유가 없어서다.
 */

import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { gameRouter } from './routes/game';

const app = express();

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

const PORT = Number(process.env.TURN_PORT ?? process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`턴제 API http://localhost:${PORT}  (POST /game/start, POST /game/guess)`);
});
