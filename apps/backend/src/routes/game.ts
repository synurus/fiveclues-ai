/**
 * 턴제 게임 API — 다섯고개(기획서 v2). 실시간(WebSocket) 없이 요청-응답만으로
 * 한 판이 진행된다(2026-09-15, 새 설계엔 다른 플레이어·토론이 없어 실시간이 필요
 * 없다고 판단). 상태는 gameToken.ts 의 암호화된 세션 토큰에 담아 클라이언트가
 * 들고 다닌다.
 *
 * 흐름:
 *   POST /game/start  → 단어를 뽑고 1라운드 묘사 5개를 생성, session 발급
 *   POST /game/guess  → session + 추측을 받아 판정
 *     - 맞으면(exact/loose 둘 다 정답 — "카메라"/"사진찍기" 같은 포함관계도 정답으로
 *       봐야 한다는 실측 논의를 그대로 따름): 결과 + 정답 공개
 *     - 1라운드에서 틀리면: 2라운드 묘사를 그 자리에서 같이 생성해 한 번에 돌려준다
 *     - 2라운드에서도 틀리면: 실패 + 정답 공개
 *   POST /game/feedback → 결과 화면에서 고른 결정적/무쓸모 힌트(복수 선택 가능) +
 *     코멘트를 GitHub Issue로 쌓는다(자가개선 루프 입력)
 */

import { Router, type Request, type Response } from 'express';
import { generateHints, judgeGuess, type Hint } from '../bot/wordGuessBot';
import { encodeSession, decodeSession, InvalidSessionError } from './gameToken';
import { pickWord } from './wordPool';
import { createFeedbackIssue, type FeedbackPayload } from '../github/feedbackIssue';

// 기획서 v2: "묘사 횟수(5회냐 4회냐)는 밸런스 보고 정할 것 — 미정". 5로 시작한다.
const HINT_COUNT = 5;

interface SessionPayload {
  word: string;
  category: string;
  accept: string[];
  round: 1 | 2; // 이 토큰으로 판정할 라운드
  round1Hints: string[]; // 2라운드 생성 시 "겹치지 말 것"에 쓴다
}

// 플레이어 화면엔 묘사 문장만 나간다 — angle은 기록·분석용이라 노출할 이유가 없다.
const toPlayerHints = (hints: Hint[]): { text: string }[] => hints.map((h) => ({ text: h.text }));

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// body에서 온 값을 "유효한 인덱스 배열"로만 걸러낸다 — 범위 검사는 hints 길이를
// 몰라서(라우트 핸들러 시점) 여기선 못 하고, 숫자 타입만 걸러 feedbackIssue.ts로 넘긴다.
const toIndexArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number' && Number.isInteger(n)) : [];

const toCountArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0) : [];

const toGuessArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

export const gameRouter = Router();

gameRouter.post('/start', async (_req: Request, res: Response) => {
  try {
    const { word, category, accept } = pickWord();
    const { hints } = await generateHints({ word, category, round: 1, hintCount: HINT_COUNT });

    const session = encodeSession<SessionPayload>({
      word,
      category,
      accept: accept ?? [],
      round: 1,
      round1Hints: hints.map((h) => h.text),
    });

    res.json({ session, round: 1, hints: toPlayerHints(hints) });
  } catch (e) {
    res.status(502).json({ error: errorMessage(e) });
  }
});

gameRouter.post('/guess', async (req: Request, res: Response) => {
  const { session, guess } = req.body as { session?: string; guess?: string };
  if (!session || typeof guess !== 'string') {
    res.status(400).json({ error: 'session과 guess가 필요합니다.' });
    return;
  }

  let payload: SessionPayload;
  try {
    payload = decodeSession<SessionPayload>(session);
  } catch (e) {
    if (!(e instanceof InvalidSessionError)) throw e;
    res.status(400).json({ error: e.message });
    return;
  }

  const verdict = judgeGuess(payload.word, guess, payload.accept);
  const correct = verdict === 'exact' || verdict === 'loose';

  if (correct) {
    res.json({ result: payload.round === 1 ? 'round1' : 'round2', word: payload.word, category: payload.category, verdict });
    return;
  }

  if (payload.round === 2) {
    res.json({ result: 'failed', word: payload.word, category: payload.category, verdict });
    return;
  }

  try {
    const previousHints: Hint[] = payload.round1Hints.map((text) => ({ text, angle: '' }));
    const { hints: round2Hints } = await generateHints({
      word: payload.word,
      category: payload.category,
      round: 2,
      hintCount: HINT_COUNT,
      previousHints,
      wrongGuess: guess,
    });

    const nextSession = encodeSession<SessionPayload>({ ...payload, round: 2 });

    res.json({ result: 'continue', session: nextSession, round: 2, hints: toPlayerHints(round2Hints) });
  } catch (e) {
    res.status(502).json({ error: errorMessage(e) });
  }
});

gameRouter.post('/feedback', async (req: Request, res: Response) => {
  const body = req.body as Partial<FeedbackPayload>;
  const outcomeOk = body.outcome === 'round1' || body.outcome === 'round2' || body.outcome === 'failed';
  if (typeof body.word !== 'string' || typeof body.category !== 'string' || !Array.isArray(body.hints) || !outcomeOk) {
    res.status(400).json({ error: 'word, category, hints, outcome이 필요합니다.' });
    return;
  }

  try {
    const { issueNumber } = await createFeedbackIssue({
      word: body.word,
      category: body.category,
      hints: body.hints.map(String),
      roundHintCounts: toCountArray(body.roundHintCounts),
      outcome: body.outcome as FeedbackPayload['outcome'],
      keyHintIndexes: toIndexArray(body.keyHintIndexes),
      uselessHintIndexes: toIndexArray(body.uselessHintIndexes),
      feedbackText: typeof body.feedbackText === 'string' ? body.feedbackText : '',
      nickname: typeof body.nickname === 'string' ? body.nickname : '',
      guesses: toGuessArray(body.guesses),
    });
    res.json({ ok: true, issueNumber });
  } catch (e) {
    res.status(502).json({ error: errorMessage(e) });
  }
});
