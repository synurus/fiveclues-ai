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

export type GuessResponse =
  | { result: 'round1' | 'round2'; word: string; category: string; verdict: 'exact' | 'loose' }
  | { result: 'continue'; session: string; round: 2; hints: Hint[] }
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

export function startGame(): Promise<StartResponse> {
  return postJson<StartResponse>('/game/start');
}

export function submitGuess(session: string, guess: string): Promise<GuessResponse> {
  return postJson<GuessResponse>('/game/guess', { session, guess });
}

export function submitFeedback(input: FeedbackInput): Promise<{ ok: true; issueNumber: number }> {
  return postJson('/game/feedback', input);
}
