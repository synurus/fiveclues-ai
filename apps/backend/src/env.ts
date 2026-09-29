// 로컬 실행용 환경변수 — 저장소 맨 위 .env 하나만 읽는다(2026-09-30). 예전엔 `import 'dotenv/config'`가
// 명령을 실행한 폴더의 .env를 읽어서 apps/backend/.env와 루트 .env(관전 모드 spectate.mjs용) 두 벌로
// 나뉘어 있었다. 배포(Vercel)·GitHub Actions엔 파일이 없어 아무것도 안 하고, 이미 있는 환경변수는
// 덮어쓰지 않는다. process.env를 모듈 로드 시점에 읽는 파일은 이걸 맨 먼저 import할 것.
import { resolve } from 'node:path';
import { config } from 'dotenv';

// src/env.ts(ts-node)든 dist/env.js(빌드)든 apps/backend 아래 한 단계라 세 단계 위가 저장소 맨 위다.
config({ path: resolve(__dirname, '../../../.env'), quiet: true });
