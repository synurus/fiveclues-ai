# CLAUDE.md — Zeteo

라이어게임 속에 숨은 봇 1명을 찾는 소셜 디덕션 웹게임. 5명(사람 4 + LLM 봇 1).

2026-09 부터 **1인 프로젝트**다. 팀 협업 규칙(PR 승인·파트 소유권·실명 라벨·`feat/*`→`dev`→`main` 규약)은
이 문서에서 덜어냈다. 브랜치는 `main` 하나만 쓴다.

---

## 구조

npm workspaces 모노레포. Node >= 22, CommonJS.

```
apps/backend    Express 5 + socket.io 4. 게임 상태·타이머·봇 호출·DB 기록
apps/frontend   React + Vite. 화면 전부
packages/shared-types   양쪽이 공유하는 계약 타입
```

**백엔드 하나가 프론트 정적 파일까지 서빙한다** (`index.ts:54` `express.static(frontend/dist)`,
`:857` SPA fallback). 그래서 배포는 서비스 하나면 된다.

**게임 상태는 서버 메모리에 있다** — `room.ts:77` `const rooms = new Map<...>()`.
DB(Supabase)에는 끝난 판만 기록한다. "기록은 사진이지 링크가 아니다" — `games.category`는
FK 없이 글자 그대로 저장.

### 화면 구조 — MainScreen 1개 + Modal 5개

게임 페이즈 내내 `screens/MainScreen.tsx`(채팅+투표)가 계속 떠 있고, 5개 페이즈만 그 위에
`components/Modal.tsx`가 얹힌다. 어느 팝업을 띄울지는 `screens/modalFor.tsx`가 정한다.

| | |
|---|---|
| MainScreen이 흡수 | describe · debate · finalDefense |
| Modal로 뜸 | roleReveal · lifeVote · reveal · guessWord · botVote |

- `reveal` → `guessWord`는 Modal 껍데기가 유지된 채 안쪽만 바뀐다. **`key={phase}`를 주면
  이 전환이 끊겨 보인다.**
- 팝업 중 채팅은 두 겹으로 막는다: 스크림이 채팅 로그를 덮고, `blocked` prop이 입력창을 잠근다.
  ✕로 접어도 잠금은 안 풀린다.
- ⚠️ **서버 `index.ts`의 `chat` 핸들러에만 `room.phase` 검사가 없다.** 다른 액션은 전부 검사한다.
  지금은 화면이 유일한 방어선이다 — 채팅 규칙을 바꾸려면 서버 가드부터 넣을 것.

---

## 돌리기

```bash
npm ci
cp apps/backend/.env.example apps/backend/.env   # 값 채우기
npm run dev -w frontend      # http://localhost:5173
npm run build                # frontend + backend
npm start                    # 프로덕션 (backend가 frontend/dist 서빙)
npm run format               # prettier
```

### mock — 서버·DB 없이 화면만

`?mock=<키>`로 바로 진입한다 (`mock/states.ts`, 하네스는 `mock/MockHarness.tsx`).

```
landing · room-list · lobby · result · survey · game-test
roleReveal-citizen · roleReveal-liar · describe-myturn · describe-waiting
debate-voted · finalDefense-accused · lifeVote-voter · lifeVote-accused
reveal-citizen · reveal-liar · guessWord-liar · guessWord-watcher
```

mock의 `myId`는 전부 `p3` 기준. `MockHarness.tsx`는 `App.tsx`의 사본 성격이라 App의 관례를 따라야 한다.

---

## 환경변수 (14개)

```
필수   SUPABASE_URL  SUPABASE_SERVICE_ROLE_KEY
봇     BOT_PROVIDER  BOT_API_KEY  BOT_BASE_URL  BOT_MODEL
       GPT_API_KEY   GPT_BASE_URL  GPT_MODEL  GPT_EFFORT_MAX
기타   PORT  ADMIN_KEY  LOG_WEBHOOK_URL  RAILWAY_GIT_COMMIT_SHA
```

- `BOT_PROVIDER`가 `'openai'`면 OpenAI 경로, 그 외(미설정 포함)는 anthropic 경로 (`bot/llm.ts:43`).
  **Groq·Cerebras는 OpenAI 호환이라 `openai` 경로에 그대로 붙는다.**
- `bot/set-provider.ts`가 `.bot-provider` 파일로 런타임 전환을 지원한다 — 한도가 차면 무재배포로 바꿀 수 있다.
- ⚠️ **`RAILWAY_GIT_COMMIT_SHA`는 `db/game.ts:51`에서 `games.bot_commit_sha`에 들어간다.**
  Railway를 떠나면 이 값이 비어서 "프롬프트를 바꾼 전후" 판 비교가 망가진다.
  플랫폼 중립 이름으로 바꾸고 새 플랫폼의 변수를 매핑할 것. 로컬에서는 **임의값을 넣지 말 것**(null이 맞다).
- `SUPABASE_SERVICE_ROLE_KEY`는 RLS를 통과하는 서버 전용 키다. 프론트나 저장소에 절대 넣지 않는다.

---

## 바꾸지 말 것 (이유가 있는 결정들)

- **react-router 안 쓴다.** 화면을 정하는 건 서버의 `phase`. URL이 또 하나의 진실이 되면
  뒤로가기 한 번에 어긋난다.
- **브레이크포인트 768px.** 출처는 `styles/tokens.css`의 `--bp-mobile`. `game.css`는 미디어쿼리에
  `var()`를 못 써서 리터럴로 중복 유지하지만 출처는 항상 그 토큰이다.
- **모바일 투표 패널은 접이식 하단 시트.** "세로로 이어붙이기"(채팅→투표→입력창 적층)는
  기획서 v3.0 D3가 명시적으로 배제했다 — 스크롤해야 투표가 보이는 게 실테스트 주요 불만이었다.
- **색·간격은 리터럴 금지, `var(--token)` 참조만.** 유일한 예외는 `.zt-modal-scrim`의
  `rgb(0 0 0 / 60%)` (딤 처리는 테마 무관).
- **제시어는 헤더 우측에 상시 표시, 라이어에겐 같은 자리·같은 크기로 `???`.**
  비워두면 빈 칸 자체가 단서가 된다.
- **참가자 표기는 "참가자 X"(A~E).** 게임 중엔 실명·아이디를 안 쓴다 — 아이디만으로도
  봇 판별에 영향을 준다.
- **roleReveal에 준비 버튼 없음. 중도 탈락 상태 없음.** 처형이 일어나면
  reveal → guessWord → result로 판이 끝난다.
- **`ResultPlayer.tags`는 배열.** 봇과 라이어가 같은 사람일 수 있다(`room.ts`의 `assignRoles`가
  봇 포함 전체를 섞는다). 겹침 없으면 `["시민"]` 하나를 보장 — 빈 배열 금지.
- **모바일은 `100dvh`**(주소창 대응). 같은 요소에 `min-height:...vh`가 남아 있으면 무력화된다.

### 제한시간 (`index.ts:64` `PHASE_DURATIONS`, `:76` `DESCRIBE_TURN_DURATION`)

```
roleReveal 10s · describe 턴당 20s · debate 120s · finalDefense 60s
lifeVote 30s · reveal 10s · guessWord 40s · botVote 20s
```

5명 기준 한 판 최소 **약 6분 30초**. 이 값은 실플레이 5판으로 측정한 것이라, 인원 구성을
바꾸면 전부 무효가 된다.

---

## 자주 걸리는 함정

**CSS**
- `position` 없는 블록 요소는 같은 스태킹 컨텍스트의 positioned 요소(z-index:0 포함)보다
  **항상 먼저(아래) 칠해진다** — DOM 순서 무관. 배경 장식을 확실히 뒤로 깔려면 **음수** z-index.
  (`ambience.css`의 배경 침범 버그 원인)
- `height`와 `min-height`를 같이 쓰면 최종값은 `max(height, min-height)`.
- `flex:1; min-height:0`을 준 요소만 눌린다. 형제는 기본 `min-height:auto`라 안 눌린다.
- flex-column 부모의 기본 `align-items:stretch`는 자식이 `inline-flex`여도 적용된다 —
  글자 폭에 맞춰야 하는 뱃지엔 `alignSelf:flex-start`.
- 뱃지가 여러 개로 늘 수 있으면 컨테이너 `flexWrap:wrap` + **개별 뱃지에 `whiteSpace:nowrap`,
  `flexShrink:0`**. 안 그러면 글자가 세로로 쪼개진다.
- `color-mix()`는 `<color>`만 받는다 — gradient 토큰을 넣으면 조용히 무효값.

**React / 타입**
- `React.memo`에 서버 브로드캐스트 객체를 통째로 넘기면 최적화가 무효. 원시값으로 풀 것.
- 단일 값 필드로 두 상태를 표현하려 3항 연산자를 쓰면 조용히 한쪽이 묻힌다.
  "이 필드가 동시에 여러 값일 수 있나"를 타입 보기 전에 자문할 것.
- 렌더 중 이전 값 비교 패턴을 쓸 것 — `useEffect`로 하면 eslint `react-hooks/set-state-in-effect`.

**검증**
- Playwright는 저장소 밖에 설치하고 `executablePath`로 chromium을 직접 지정.
- 증상별: 크기는 `getBoundingClientRect()` / 배경은 `getComputedStyle(el).background` /
  뷰포트 맞춤은 `documentElement.scrollHeight <= window.innerHeight`를 여러 폭으로 스윕 /
  팝업 스크롤은 `el.scrollHeight > el.clientHeight` 임계값 측정 /
  스크롤바 색은 `getComputedStyle`(헤드리스 Chromium은 스크롤바를 숨겨 스크린샷엔 안 보인다).
- 존재하지 않는 요소에 `.textContent()`는 30초 타임아웃 — `count()` 먼저.

---

## 아직 안 정해진 것

- **`fetchSurveyReasons()`가 최초 조회를 프로세스 메모리에 무기한 캐싱한다** (`db/survey.ts`).
  DB에서 설문 문구를 바꿔도 서버 재시작 전엔 반영이 안 된다 — "몇 판마다 문항 교체" 계획과 충돌.
- 설문 화면 모바일 결과패널 스크롤 (320px 상한에 콘텐츠 478px). 압축 시안 A/B/C 실측까지
  해뒀고 방향 미선택. A안이 비용 최저·정보 손실 없음.
- "채팅 입력 후 4~5초 뒤 몰려 나타남" — 렌더 성능은 아님. 유력 가설은 재연결 백오프. 실기기 미확인.
- 봇 지목 화면 재진입 시 이전 선택이 남는 버그 — 진단만, 수정 롤백됨.
- Ambience(달빛·핏방울)가 랜딩·대기실·결과에서 배경 div에 완전히 가려져 애초에 안 보이는
  구조일 수 있다 — 실기기 확인 필요.
- **방 안 전원이 준비완료해야만 게임이 시작된다** (게임시작 버튼을 지운 결과). 한 명이라도
  준비를 안 누르면 아무도 시작시킬 수 없다.

## 운영 전환 중 (2026-09)

Railway 무료가 30일로 끝나서 배포처와 봇 프로바이더를 옮기는 중.

- ⚠️ **Vercel은 안 된다.** 함수 최대 300초(Hobby는 연장 불가)인데 한 판이 6분 30초고,
  socket.io 브로드캐스트가 인스턴스를 넘지 못하며, `rooms` Map이 메모리에 있다. 3중으로 막힌다.
- 유휴 시 잠드는 플랫폼으로 가면 **재접속 복구가 선택이 아니라 필수**가 된다
  (기획서 v4.0이 "나갔다 돌아온 사람의 상태를 어디까지 되살릴 것인가"를 미결로 남겨뒀다).
- Supabase 무료는 일주일 무활동 시 일시정지된다(대시보드에서 Resume, 정지 후 1년 내).
- 모델을 바꾸면 봇 품질을 재측정하고 `games.bot_model`로 이전 판과 구분할 것.
  프롬프트는 경향만 만든다 — 반드시 지켜야 할 규칙은 코드로 검사한다(이건 모델이 바뀌어도 유지된다).
