// AI 라이어게임 턴제 API 클라이언트. apps/backend/src/routes/game.ts 와 짝이다.
// dev: vite.config.ts 의 /game 프록시가 localhost:3000(turnServer.ts)으로 넘긴다.
// prod: 프론트와 API가 같은 origin에서 서빙된다고 가정한다 — 배포처가 아직
// 미확정이라(Vercel Functions 유력) 지금은 상대 경로로만 써둔다.

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
  hints: string[]; // 1·2라운드 전부, 순서대로 — keyHintIndex/uselessHintIndex가 이 배열의 인덱스다.
  outcome: 'round1' | 'round2' | 'failed';
  keyHintIndex: number | null;
  uselessHintIndex: number | null;
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
