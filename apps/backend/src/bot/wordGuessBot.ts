/**
 * 다섯고개 — 봇 출제자 프롬프트 + 호출.
 *
 * scripts/spectate.mjs 에서 8세대 실측으로 검증한 프롬프트를 그대로 옮긴 것이다.
 * 정답 판정(judgeGuess)은 사람 플레이어의 입력을 그대로 받는다 — 관전 모드의
 * 자동추측 LLM 호출은 프로덕션엔 없다(애초에 여기선 필요가 없다).
 *
 * spectate.mjs 8세대 실측 요약 — 이 순서로 바뀌었고 전부 이 파일에 반영돼 있다.
 *   1) [각도] 목록·"N개가 서로 다른 성격이어야 한다" 제약 삭제 — 지우니 오히려
 *      정답률이 올랐다(70%→77%). 모델이 자기 검열보다 자유롭게 쓸 때 더 자연스러웠다.
 *   2) (관전 모드 한정) 추측자에게 주제를 주지 않게 수정 — 프로덕션은 추측자가
 *      사람이라 애초에 해당 없다. 출제자에게는 여전히 준다 — "주제 안의 다른 것
 *      두셋에도 들어맞게"가 난이도의 핵심이라서.
 *   3) 2라운드가 1라운드 오답(wrongGuess)을 알게 함 — 모르면 1라운드가 우연히 준
 *      인상을 2라운드가 그대로 이어받아 같은 오답이 반복됐다(매실차→커피→커피 재현).
 * 그래도 1라운드 정답률은 55~85% 사이를 오갔고 목표 밴드(25~35%, 기획서 v2 §8)엔
 * 못 미쳤다 — LLM 자동추측자가 사람보다 문맥 추론에 훨씬 강해서 생기는 구조적
 * 격차로 판단, 수치 추적은 멈추고 정성 검토로 전환했다(2026-09-15).
 *
 * 환경변수: BOT_BASE_URL, BOT_API_KEY, BOT_MODEL (OpenAI 호환 엔드포인트)
 *   Groq 기본값 사용 시 모델은 openai/gpt-oss-120b.
 */

import 'dotenv/config';
import { hintSystem } from './hintPrompt';

const BASE_URL = process.env.BOT_BASE_URL ?? 'https://api.groq.com/openai/v1';
const API_KEY = process.env.BOT_API_KEY ?? '';
const MODEL = process.env.BOT_MODEL ?? 'openai/gpt-oss-120b';

export interface Hint {
  text: string;
  /** 무엇에 대해 말했는지 기록용 라벨. 생성 제약이 아니라 사후 분석용이다. */
  angle: string;
}

export interface HintRound {
  /** 이 단어를 들으면 바로 떠오르는 결정적 특징들 — 묘사에서 실제로 제외됐는지 검증용. */
  banned: string[];
  hints: Hint[];
}

export interface GenerateHintsInput {
  word: string;
  category: string;
  round: 1 | 2;
  /** 라운드당 묘사 개수. 기획서 v2: 밸런스 보고 정할 것(4~5 범위에서 실측함). */
  hintCount: number;
  /** round === 2 일 때 필수 — 1라운드 묘사(겹치지 않게 하는 데 쓴다). */
  previousHints?: Hint[];
  /** round === 2 일 때 필수 — 1라운드 오답. */
  wrongGuess?: string;
}

export type GuessJudgement = 'exact' | 'loose' | 'wrong';

const normalize = (s: string): string => String(s ?? '').replace(/[\s.,!?"'·]/g, '').trim();

/**
 * 정답 판정. LLM을 쓰지 않는다 — 플레이어가 직접 입력하므로 문자열 비교면 된다.
 *   exact  정답과 같거나 accept(동의어)에 있음
 *   loose  한쪽이 다른 쪽을 포함 (경찰관/경찰, 골프/골프공)
 *   wrong  그 외
 */
export function judgeGuess(word: string, guess: string, accept: string[] = []): GuessJudgement {
  const g = normalize(guess);
  if (!g) return 'wrong';
  if (g === normalize(word)) return 'exact';
  if (accept.some((a) => normalize(a) === g)) return 'exact';
  if (g.includes(normalize(word)) || normalize(word).includes(g)) return 'loose';
  return 'wrong';
}

// ── LLM 호출 ───────────────────────────────────────────────────────────

export class LlmError extends Error {
  /** true면 재시도해도 소용없다(키 문제 등) — 호출부가 즉시 포기해야 한다. */
  fatal = false;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(res: Response, body: string): number {
  const h = Number(res.headers.get('retry-after'));
  if (Number.isFinite(h) && h > 0) return h * 1000 + 500;
  const m = body.match(/try again in ([\d.]+)\s*s/i);
  if (m) return Number(m[1]) * 1000 + 500;
  return 5000;
}

async function listModels(): Promise<string> {
  try {
    const res = await fetch(`${BASE_URL}/models`, { headers: { authorization: `Bearer ${API_KEY}` } });
    const data = (await res.json()) as { data?: { id: string }[] };
    const ids = data.data?.map((m) => m.id).sort() ?? [];
    return ids.length ? ids.map((id) => `  ${id}`).join('\n') : '  (목록을 받지 못했다)';
  } catch {
    return '  (목록 조회 실패)';
  }
}

/** gpt-oss 계열은 추론 토큰이 max_tokens 예산을 같이 먹는다 — 예산 부족하면 빈 JSON이 온다. */
const isReasoningModel = (model: string): boolean => /gpt-oss/.test(model);

// export: autoPlay.ts(자가개선 AI 자동플레이)가 같은 재시도·reasoning-model
// 처리 로직을 그대로 재사용한다 — 추측자·소감 LLM 호출도 출제자와 같은 엔드포인트/
// 429 재시도 규칙을 타므로 새로 짤 이유가 없다.
export async function callBot(system: string, user: string): Promise<string> {
  const body = JSON.stringify({
    model: MODEL,
    temperature: 0.9,
    max_tokens: 4000,
    response_format: { type: 'json_object' },
    ...(isReasoningModel(MODEL) ? { reasoning_effort: 'low', reasoning_format: 'hidden' } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body,
    });
    if (res.ok) {
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content?.trim() ?? '';
    }

    const text = await res.text();

    // 무료 티어 TPM 한도. 서버가 알려준 만큼 기다렸다 이어간다.
    if (res.status === 429 && attempt <= 6) {
      await sleep(retryAfterMs(res, text));
      continue;
    }
    if (res.status === 404 && text.includes('model_not_found')) {
      throw new Error(`모델 "${MODEL}" 을(를) 이 키로 쓸 수 없다.\n사용 가능한 모델:\n${await listModels()}`);
    }
    if (text.includes('json_validate_failed')) {
      throw new Error(
        `JSON 생성 실패. 추론 토큰이 max_tokens 를 다 먹었을 가능성이 크다 — ` +
          `max_tokens 를 올리거나 reasoning_effort 를 낮춰볼 것.\n${text.slice(0, 300)}`,
      );
    }
    const err = new LlmError(`LLM ${res.status}: ${text.slice(0, 300)}`);
    if (res.status === 401 || res.status === 403) err.fatal = true;
    throw err;
  }
}

// export: autoPlay.ts 도 LLM 응답(추측·소감)을 같은 방식으로 관대하게 파싱해야 해서 재사용.
export function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as T;
      } catch {
        /* 무시 */
      }
    }
    return fallback;
  }
}

// ── 프롬프트 ───────────────────────────────────────────────────────────
// hintSystem 은 hintPrompt.ts 로 옮겼다(자가개선 워크플로가 그 파일만 건드리게 하려고).

function hintUser(
  word: string,
  round: 1 | 2,
  hintCount: number,
  previousHints?: Hint[],
  wrongGuess?: string,
): string {
  if (round === 1) {
    return `제시어: ${word}\n\n묘사 ${hintCount}개를 만들어라.`;
  }
  const prev = (previousHints ?? []).map((h) => `- ${h.text}`).join('\n');
  // wrongGuess 를 알려주되 "OOO 아니다"처럼 직접 부정하게는 시키지 않는다 — 직접
  // 부정하면 그 범주 전체가 한 번에 배제돼 오히려 너무 쉬워진다. 그냥 놔두면
  // 1라운드 힌트가 우연히 만든 인상을 2라운드가 그대로 이어받는다(매실차→커피→커피).
  return (
    `제시어: ${word}\n\n1라운드에서 이미 나온 묘사(겹치지 말 것):\n${prev}\n\n` +
    `1라운드 추측은 "${wrongGuess}"였고 오답이었다. 그 추측이 다시 나올 만한 인상은` +
    ` 피하되, "${wrongGuess}가 아니다"처럼 직접 부정하지는 마라.\n\n` +
    `2라운드 묘사 ${hintCount}개를 만들어라.`
  );
}

/**
 * 묘사 생성. 라운드당 LLM 호출 1번(기획서 v2 — "봇을 5번 부르지 않는다").
 * round === 2 면 previousHints·wrongGuess 가 필수다.
 */
export async function generateHints(input: GenerateHintsInput): Promise<HintRound> {
  const { word, category, round, hintCount, previousHints, wrongGuess } = input;
  if (round === 2 && (!previousHints || wrongGuess === undefined)) {
    throw new Error('2라운드는 previousHints 와 wrongGuess 가 필요하다.');
  }

  const system = hintSystem(round, category, hintCount);
  const user = hintUser(word, round, hintCount, previousHints, wrongGuess);
  const raw = await callBot(system, user);
  const out = parseJson<{ banned?: unknown; hints?: unknown }>(raw, {});

  const hints = out.hints;
  if (!Array.isArray(hints) || !hints.length) {
    throw new Error('묘사 파싱 실패: ' + raw.slice(0, 300));
  }

  return {
    banned: Array.isArray(out.banned) ? out.banned.map(String) : [],
    hints: (hints as { text?: unknown; angle?: unknown }[]).map((h) => ({
      text: String(h.text ?? ''),
      angle: String(h.angle ?? '?').slice(0, 20),
    })),
  };
}
