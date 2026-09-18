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
}

// 세션 발급 시 한 번만 넘긴다 — 2라운드부터는 세션 토큰 안의 값을 서버가 그대로
// 쓴다(2026-09-17 영어 버전 추가).
export type Lang = 'ko' | 'en';

export type GuessResponse =
  | { result: 'round1' | 'round2'; word: string; category: string; verdict: 'exact' | 'loose' }
  | { result: 'continue'; session: string; round: 2; category: string; hints: Hint[] }
  | { result: 'failed'; word: string; category: string; verdict: 'wrong' };

// 자가개선 루프(scripts/self-improve/)가 GitHub Issue로 쌓는 피드백.
// apps/backend/src/github/feedbackIssue.ts 의 FeedbackPayload 와 필드가 같아야 한다.
export interface FeedbackInput {
  word: string;
  category: string;
  hints: string[]; // 1·2라운드 전부, 순서대로 — keyHintIndexes/uselessHintIndexes가 이 배열의 인덱스다.
  roundHintCounts: number[]; // hints를 라운드별로 다시 자를 때 쓰는 길이들 — 합은 hints.length와 같다.
  guesses: string[]; // 라운드별로 실제 뭐라고 추측했는지, 순서대로.
  outcome: 'round1' | 'round2' | 'failed';
  keyHintIndexes: number[]; // 결정적이었던 힌트(들). 여러 개 태그 가능, 없으면 [].
  uselessHintIndexes: number[]; // 무쓸모였던 힌트(들). 여러 개 태그 가능, 없으면 [].
  feedbackText: string;
  nickname: string;
  lang: Lang;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// exclude: 이번 브라우저 세션에서 이미 나온 단어들 — 반복 출제 방지(2026-09-19).
// 서버가 "최근 단어"를 기억할 상태가 없어서(DB 없음, 서버리스) 클라이언트가 들고
// 다니다 매번 같이 보낸다.
export function startGame(lang: Lang, exclude: string[] = []): Promise<StartResponse> {
  return postJson<StartResponse>('/game/start', { lang, exclude });
}

export function submitGuess(session: string, guess: string): Promise<GuessResponse> {
  return postJson<GuessResponse>('/game/guess', { session, guess });
}

export function submitFeedback(input: FeedbackInput): Promise<{ ok: true; issueNumber: number }> {
  return postJson('/game/feedback', input);
}
