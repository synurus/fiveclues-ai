# CLAUDE.md

이 문서를 읽는 세션에게: 이 프로젝트는 2026-09-15에 팀 프로젝트(라이어게임,
사람 1 + 봇 다수가 라이어를 투표하는 소셜 디덕션 게임)에서 완전히 다른 게임으로
갈아엎었다. 2026-09-16엔 그 팀 프로젝트 시절 코드·문서·구조를 전부 걷어내고
지금의 단순한 구조로 다시 정리했다. **팀 프로젝트 시절의 기억이나 문서를 참고하지
마라 — 화면 구조도, DB도, 배포처도, 게임 룰 자체도 전부 다르다.**

## 지금 이 게임이 뭔가

이름은 **다섯고개**(레포명 `fiveclues-ai`, 2026-09-16 확정 — "스무고개"에서 따온
이름이라 팀 프로젝트 시절 이름 "라이어게임"과는 전혀 무관하다).

**AI의 묘사를 통해 제시어를 맞추는 게임.** 다른 플레이어도, 라이어도, 투표도
없다. 봇 하나가 묘사 5개를 만들고, 사람이 그걸 보고 제시어를 추측한다. 틀리면
묘사 5개를 더 받고 한 번 더 추측한다. 판이 끝나면 어떤 묘사가 결정적이었고
어떤 묘사가 무쓸모였는지 직접 태그한다 — 그게 자가개선 루프의 학습 신호다.
자세한 설계 근거는 `docs/게임기획서_v2.md`.

## 핵심 설계 판단 — 왜 이렇게 됐는가

- **실시간(WebSocket) 없음.** 다른 플레이어·토론이 없는 구조라 소켓이 필요
  없다고 판단(2026-09-15). API는 순수 요청-응답(`apps/backend/src/routes/game.ts`).
- **DB 없음, 세션은 암호화 토큰으로(2026-09-16 확정 — 앞으로도 안 쓴다).**
  라운드 사이 상태(제시어)를 서버가 안 들고 있고, 클라이언트가 AES-256-GCM으로
  암호화된 토큰을 들고 다닌다(`apps/backend/src/routes/gameToken.ts`). 서버가
  매 요청마다 새로 뜰 수 있다는 전제(서버리스 배포)와 잘 맞는다.
- **라운드당 묘사 5개(2026-09-16 확정).** `routes/game.ts`와 `bot/autoPlay.ts`
  양쪽의 `HINT_COUNT = 5`가 실제 게임과 같은 조건이어야 한다는 전제라, 바꾸게
  되면 둘 다 같이 고쳐야 한다.
- **피드백 저장소는 GitHub Issues.** 파일 커밋(Contents API)이 아니라 Issue를
  쓰는 이유는 동시에 여러 명이 피드백을 보내도 SHA 충돌이 없어서다
  (`apps/backend/src/github/feedbackIssue.ts`).
- **자가개선 루프가 건드리는 범위는 `hintPrompt.ts` 파일 하나뿐이다.**
  `wordGuessBot.ts`에서 일부러 분리해뒀다 — 재시도·타입·API 호출 같은 코드
  로직은 자동화가 절대 못 건드리게, 손이 닿는 범위를 "프롬프트 문구"로
  물리적으로 좁힌 것. 안전장치 4단계는 `scripts/self-improve/propose.mjs`
  상단 주석 참고.
- **배포는 Vercel(2026-09-16 결정).** `apps/backend/src/app.ts`가 Express 앱
  본체(라우팅만, `app.listen()` 없음)이고, `server.ts`(로컬 개발)와
  `/api/index.ts`(Vercel 서버리스 함수) 둘 다 이걸 재사용한다.

## 코드에서 반드시 알아야 할 함정

- **`apps/backend/src/routes/wordPool.ts`가 `scripts/words.json`을
  `fs.readFileSync`로 읽는다(import가 아니다).** `apps/backend`의
  tsconfig가 `rootDir: "./src"`라 `src` 바깥 파일을 정적 import하면 `tsc`가
  rootDir 위반으로 빌드를 거부한다. `fs` 읽기는 컴파일 타임 추적 대상이 아니라
  이 제약을 피해간다. Vercel에서 이 파일이 함수에 같이 묶이는 건 `import`
  추적이 아니라 **루트 `vercel.json`의 `functions["api/index.ts"].includeFiles`
  설정**이 보장한다 — `words.json` 경로를 바꾸면 이 설정도 같이 고쳐야 한다.
- **비어 있는 선택적 환경변수는 `??`가 아니라 `||`로 받아라 — GitHub Actions만의
  특성이 아니다.** 값을 안 채운 환경변수는 undefined가 아니라 빈 문자열(`""`)로
  온다. `??`는 `""`를 "값 있음"으로 쳐버려서 기본값으로 안 넘어간다. `propose.mjs`의
  `SELFIMPROVE_BOT_*` → `BOT_*` fallback 체인(GitHub Actions, 2026-09-16 이
  버그로 하루 날렸다)뿐 아니라 `wordGuessBot.ts`의 `BOT_BASE_URL`/`BOT_MODEL`도
  같은 이유로 `||`를 쓴다 — Vercel에 값 없이 키만 등록해도 똑같이 `""`가 와서,
  처음엔 `??`를 썼다가 배포 후 "Failed to parse URL from /chat/completions"로
  터졌다(2026-09-16). 새 환경변수를 읽는 코드를 추가할 땐 무조건 `||`를 써라.
- **`keyHintIndexes`/`uselessHintIndexes`는 배열이다(숫자 하나가 아니다).**
  결과 화면에서 힌트 말풍선 여러 개를 동시에 태그할 수 있다(2026-09-16 개편).
  `FeedbackPayload`(`feedbackIssue.ts`), `FeedbackInput`(프론트
  `wordgame/api.ts`), `autoPlay.ts`의 `reflectFeedback()` 셋 다 이 스키마를
  맞춰 써야 한다. `propose.mjs`의 `summarizeForPrompt()`는 마이그레이션 전
  옛 이슈(숫자 하나짜리)도 여전히 읽을 수 있게 두 형태 다 받아준다.
- **`FeedbackPayload`엔 `roundHintCounts`/`guesses`도 있다(2026-09-16 추가).**
  `hints`(전체 라운드 힌트, flat)를 `roundHintCounts`(라운드별 개수, 예:
  `[5, 5]`)로 다시 잘라 라운드 경계를 알아내고, `guesses`(라운드별 실제
  추측)와 짝지어 GitHub Issue 본문에 "라운드별 힌트 + 그 라운드 추측/정오답"을
  구분선(`────`)으로 나눠 보여준다(`feedbackIssue.ts`의 `buildHintLog`).
  결과 화면(`WordGuessGame.tsx`)의 `RoundLog[]` 상태를 그대로 펼친 것 —
  프론트에서 이 필드를 안 보내면 `feedbackIssue.ts`가 한 라운드로 뭉뚱그려
  방어적으로 처리한다(`splitByRound`).
- **`scripts/words.json`이 유일한 정본이다.** `apps/backend/src/data/`에
  사본을 두지 마라(2026-09-16 이전엔 둘이 있었고 내용이 갈라질 위험이
  실제로 있었다) — 단어를 고치거나 추가할 땐 이 파일 하나만 고치면
  `wordPool.ts`(런타임)와 `spectate.mjs`(관전 모드)가 둘 다 따라간다.
- **`scripts/spectate.mjs`는 서버 없이 `generateHints`/`judgeGuess`를 직접
  import해서 프롬프트를 실측하는 도구다.** `bot/autoPlay.ts`도 같은 이유로
  같은 패턴을 쓴다 — 서버가 항상 떠 있다는 보장이 없는(서버리스) 배포에서
  HTTP로 자기 자신을 호출하는 것보다 로직을 직접 불러 쓰는 게 더 단순하다.

## 자가개선 루프 스케줄 (KST 기준)

- **01~07시, 매시** — `.github/workflows/self-improve-autoplay.yml`이
  `bot/autoPlay.ts`를 돌려 AI가 직접 몇 판을 플레이하고 피드백 이슈를 쌓는다.
  Groq 무료 티어 TPM 한도를 게임 본체와 나눠 써서, 여러 판을 동시에 돌리지
  않고 순서대로 돈다.
- **08시, 하루 한 번** — `.github/workflows/self-improve.yml`이 그때까지
  쌓인 피드백(사람 + AI)을 전부 모아 `hintPrompt.ts` 수정 PR을 연다. 07시가
  아니라 08시인 이유: 자동플레이의 마지막 실행(07시)과 Groq 호출이 겹치는
  걸 피하려고 한 시간 늦췄다.
- 병합은 항상 사람이 한다. PR이 이상하면 그냥 닫으면 된다 — 다음 실행 때
  새 PR이 다시 열린다.
