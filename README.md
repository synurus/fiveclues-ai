# AI 라이어게임

AI가 내놓는 묘사 5개를 보고 제시어를 맞히는 낱말 게임. 틀리면 묘사 5개를 더 받고
한 번 더 맞힌다. 판이 끝나면 어떤 묘사가 결정적이었고 어떤 묘사가 쓸모없었는지
직접 태그하는데, 그 피드백이 매일 밤 자동으로 모여 출제자 프롬프트를 스스로
고치는 PR로 돌아온다 — "자가개선 루프"가 이 프로젝트의 핵심이다.

## 구조

```
apps/
  backend/    Express API. 세션은 DB 없이 암호화 토큰(AES-256-GCM)으로 유지한다.
  frontend/   React + Vite 화면 하나(WordGuessGame).
api/          Vercel 서버리스 함수 진입점 — apps/backend의 Express 앱을 그대로 감싼다.
scripts/
  words.json          제시어 풀(단일 소스, ~290개).
  spectate.mjs         서버 없이 힌트 프롬프트를 실측/튜닝하는 관전 모드.
  self-improve/        자가개선 루프 본체(아래 참고).
.github/workflows/     자가개선 루프를 매일 밤 돌리는 스케줄.
docs/                  기획서·자가개선 설계 문서.
```

## 로컬 실행

```bash
npm install
cp apps/backend/.env.example apps/backend/.env   # 값 채우기
npm run dev:api    # http://localhost:3000
npm run dev:web    # http://localhost:5173 (vite가 /game을 3000번으로 프록시)
```

필수 환경변수는 `apps/backend/.env.example`에 설명과 함께 있다. 최소한
`GAME_TOKEN_SECRET`(`openssl rand -base64 32`)과 `BOT_API_KEY`(LLM 호출용,
기본은 Groq 무료 티어)가 있어야 게임이 동작한다.

## 자가개선 루프

1. **수집** — 사람이 결과 화면에서 힌트를 태그하며 남긴 피드백 + AI가 새벽에
   직접 플레이하며 만든 피드백이 모두 `feedback` 라벨 GitHub Issue로 쌓인다
   (`apps/backend/src/github/feedbackIssue.ts`).
2. **AI 자동플레이** — 매일 01~07시(KST) 매시, `apps/backend/src/bot/autoPlay.ts`가
   서버 없이 한 판을 직접 흉내 내고(단어 뽑기 → 힌트 생성 → LLM이 추측 → 결과
   소감까지) 피드백 이슈를 만든다. 사람 피드백이 적은 시간대에도 학습 신호가
   끊기지 않게 하려는 것.
3. **제안** — 매일 08시(KST), `scripts/self-improve/gather.mjs`가 그때까지 쌓인
   피드백 이슈를 전부 모으고, `scripts/self-improve/propose.mjs`가 LLM으로
   `apps/backend/src/bot/hintPrompt.ts`를 다시 써서 PR을 연다.
4. **병합은 사람이 한다.** PR은 구조 가드(함수 시그니처·JSON 스키마 유지)와
   `tsc --noEmit` 통과를 거쳐야 열리고, 이미 열린 PR이 있으면 새로 열지 않는다.
   자세한 설계는 `docs/자가개선_설계.md` 참고.

## 배포 (Vercel)

이 레포 자체를 Vercel 프로젝트로 연결하면 `vercel.json`이 프론트(정적 빌드)와
`/game/*` API(서버리스 함수 `api/index.ts`)를 같은 도메인에서 같이 서빙한다.
Vercel 프로젝트의 Environment Variables에 `.env.example`과 같은 키를 넣으면 된다.

## 스택

React 19 + Vite · Express 5 · TypeScript · Groq(OpenAI 호환 엔드포인트) ·
GitHub Issues(피드백 저장) · GitHub Actions(자가개선 스케줄) · Vercel(배포)
