// 다섯고개 턴제 API 클라이언트. apps/backend/src/routes/game.ts 와 짝이다.
// dev: vite.config.ts 의 /game 프록시가 localhost:3000(server.ts)으로 넘긴다.
// prod(Vercel): 프론트와 API가 같은 origin에서 서빙된다 — vercel.json의 rewrites가
// /game/* 을 서버리스 함수(api/index.ts)로 보낸다. 그래서 여기선 항상 상대 경로만 쓴다.

export interface Hint {
  text: string;
}

export interface StartResponse {
  session: string;
  round: 1;
  hints: Hint[];
  /** 쉬움 모드로 시작했을 때만 — 1라운드부터 보여 줄 카테고리. */
  category?: string;
}

// 세션 발급 시 한 번만 넘긴다 — 2라운드부터는 세션 토큰 안의 값을 서버가 그대로
// 쓴다(2026-09-17 영어 버전 추가).
export type Lang = 'ko' | 'en';

// resultToken: 판이 끝났을 때 서버가 주는 암호화된 판 기록 — 피드백은 이걸로만 보낸다
// (2026-09-28, 서버가 판 내용을 클라이언트 말만 믿지 않게).
// banned: 출제 AI가 일부러 피한 결정적 특징 — 결과 화면에 공개(2026-09-29). 없을 수도 있다.
export type GuessResponse =
  | { result: 'round1' | 'round2'; word: string; category: string; verdict: 'exact' | 'loose'; resultToken: string; banned?: string[] }
  | { result: 'continue'; session: string; round: 2; category: string; hints: Hint[] }
  | { result: 'failed'; word: string; category: string; verdict: 'wrong'; resultToken: string; banned?: string[] };

// 자가개선 루프(scripts/self-improve/)가 GitHub Issue로 쌓는 피드백. 단어·묘사·추측은
// resultToken 안에 있고, 여기선 플레이어가 결과 화면에서 고른 것만 보낸다.
export interface FeedbackInput {
  result: string; // GuessResponse의 resultToken
  playCount: number; // 이 브라우저에서 몇 번째로 끝낸 판인지(playCount.ts). 0이면 서버가 무시.
  keyHintIndexes: number[]; // 결정적이었던 힌트(들) — 1·2라운드를 이어 붙인 순서의 인덱스. 없으면 [].
  uselessHintIndexes: number[]; // 무쓸모였던 힌트(들). 없으면 [].
  feedbackText: string;
  nickname: string;
}

/** 서버 오류. code로 화면 문구를 고른다(game.ts의 { error, code }). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(0, 'network', e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    const code = typeof data.code === 'string' ? data.code : res.status === 429 ? 'rate_limited' : 'unknown';
    throw new ApiError(res.status, code, typeof data.error === 'string' ? data.error : `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// exclude: 이 브라우저에서 최근에 나온 단어들(history.ts recentWords) — 반복 출제 방지(2026-09-19).
// 서버가 "최근 단어"를 기억할 상태가 없어서(DB 없음, 서버리스) 클라이언트가 들고
// 다니다 매번 같이 보낸다.
// easy: 쉬움 모드(1라운드부터 카테고리 공개, 2026-09-29).
export function startGame(lang: Lang, exclude: string[] = [], easy = false): Promise<StartResponse> {
  return postJson<StartResponse>('/game/start', { lang, exclude, easy });
}

// 오늘의 문제(2026-09-29). date는 이 기기의 날짜 — 서버가 UTC ±1일 안인지 본다.
// 그날 문제가 없으면 ApiError(code 'daily_unavailable').
export interface DailyStartResponse extends StartResponse {
  daily: { date: string; number: number };
}
// archive: 지난 문제 다시 풀기(2026-09-29) — 서버가 1번 문제부터 UTC 내일까지의 날짜를 받는다.
export function startDaily(lang: Lang, date: string, easy = false, archive = false): Promise<DailyStartResponse> {
  return postJson<DailyStartResponse>('/game/daily/start', { lang, date, easy, archive });
}

/** 지난 문제 목록(날짜·번호만, 최신 먼저). 화면이 자기 날짜보다 앞선 것만 보여 준다. */
export function listDaily(lang: Lang): Promise<{ puzzles: { date: string; number: number }[] }> {
  return postJson('/game/daily/list', { lang });
}

export function submitGuess(session: string, guess: string): Promise<GuessResponse> {
  return postJson<GuessResponse>('/game/guess', { session, guess });
}

export function submitFeedback(input: FeedbackInput): Promise<{ ok: true; issueNumber: number }> {
  return postJson('/game/feedback', input);
}
