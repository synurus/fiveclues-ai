# AGENTS.md

이 저장소에서 작업하는 모든 AI 에이전트(Claude Code, Codex, Cursor, Gemini CLI, Copilot 등)가
공통으로 따르는 안내. 2026-09-30 작업 계정이 바뀌면서 Claude 전용 메모리에만 있던 규칙을 여기로 옮겼다.

## 먼저 읽을 것
1. **`CLAUDE.md`** — 이름은 Claude용이지만 모든 에이전트에 해당한다. 설계 판단, 코드의 함정,
   자동화 스케줄, 무료 LLM 한도가 전부 여기 있다. 작업 전에 끝까지 읽을 것.
2. **`docs/운영가이드.md`** — 운영 절차(수동 실행, 검토 이슈, 자가개선 PR, 토큰 만료, 장애 대응).
3. `docs/게임기획서_v3.md` — 게임 현재 상태와 로드맵.

## 작업 규칙 (운영자 요청)
- **보고·설명·질문은 한국어로.**
- **운영자 실명은 어디에도 쓰지 않는다** — 코드, 커밋, 이슈, 문서, 대화 모두. 표기는 흑기사(Black_Knight).
  옛 팀원도 실명 대신 "팀원A/B/C" 등으로.
- **커밋·푸시:** 검증(아래 명령)을 통과하면 main에 커밋·푸시를 묻지 않고 해도 된다. 원격이 앞서 있으면
  `git pull --rebase` 후 다시 푸시(자동화 봇이 데이터 파일을 수시로 커밋한다).
  **하지 않는 것:** 강제 푸시, PR 병합(자가개선 PR 포함 — 병합은 운영자가 한다), 로컬 전용 브랜치
  `main-old-team-history` 푸시.
- **비밀값은 출력·커밋하지 않는다.** 저장소 맨 위 `.env`(깃에 안 올라감, 2026-09-30부터 이 파일 하나 — `apps/backend/src/env.ts`가 읽는다)의 값을 화면에 찍지
  말고, 키 이름만 다룬다. 저장소 밖 키 메모 파일도 열지 않는다.
- **출제 지시문(`apps/backend/src/bot/hintPrompt.ts`, `hintPromptEn.ts`)을 고칠 때**
  - 토큰 사용량을 실측해 수정 전후를 절대 수치와 %로 보고한다(`max_tokens` 5짜리 호출 1번씩이면 충분).
  - 헤더 주석에 날짜별 이력을 길게 쌓지 않는다(자가개선 스크립트가 파일 전체를 LLM에 넣는다).
  - 한국어판을 의미 있게 바꾸면 영어판도 맞출지 운영자에게 확인한다(영어판은 자동화 대상이 아니다).
  - 운영자가 직접 고친 경우 `scripts/prompt-history-notes.json`에 새 세대 해시로 쉬운 설명 한 줄을
    추가한다(해시: `bot/promptVersion.ts`의 `PROMPT_VERSION`).
- **여러 판짜리 LLM 실측·A/B 테스트는 돌리기 전에 운영자에게 묻는다** — 운영과 같은 무료 키라서
  테스트가 실제 게임 한도를 먹는다(Groq 하루 토큰 한도에 걸려 게임이 멈춘 적이 있다).
- **데이터 흐름을 바꾸면** `apps/frontend/privacy.html`·`en/privacy.html`을 같이 고친다.

## 검증 명령
```bash
npm test -w backend                                        # 판정·토큰·게임 API 통합 테스트
node --test "scripts/self-improve/*.test.mjs" scripts/*.test.mjs
npx tsc -p apps/backend --noEmit                           # 백엔드 타입 검사(배포 빌드는 이걸 안 한다)
npm run lint -w frontend && npm run build -w frontend
```
화면이 바뀌는 변경은 `npm run dev`(화면 5173, API는 `API_PORT` 기본 3000)로 직접 확인한다.

## GitHub
- 이 PC엔 `gh` CLI가 없다. 이슈·PR·실행 기록은 공개 API(`https://api.github.com/repos/synurus/fiveclues-ai/...`)로
  인증 없이 읽는다.
- 워크플로 수동 실행은 맨 위 `.env`의 `GITHUB_ACTIONS_TOKEN`(Actions 읽기·쓰기만 있는 로컬 전용
  토큰)으로 `POST /repos/synurus/fiveclues-ai/actions/workflows/<파일명>/dispatches`
  (`{"ref":"main","inputs":{...}}`, 성공하면 204). 또는 운영자가 Actions 화면의 Run workflow 버튼으로.
