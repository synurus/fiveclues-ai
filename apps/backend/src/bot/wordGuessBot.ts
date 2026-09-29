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
 * 환경변수:
 *   BOT_BASE_URL, BOT_API_KEY, BOT_MODEL — Groq(OpenAI 호환). 기본 모델 openai/gpt-oss-120b.
 *     출제 체인의 groq 항목과 자동플레이 추측자(기본값)가 쓴다.
 *   GEMINI_API_KEY(없으면 SELFIMPROVE_BOT_API_KEY) — 출제 체인의 gemini 항목.
 *   HINT_MODEL_CHAIN — 출제 모델 순서를 코드 수정 없이 바꿀 때(아래 "출제 모델 체인").
 */

import 'dotenv/config';
import { hintSystem as hintSystemKo } from './hintPrompt';
import { hintSystem as hintSystemEn } from './hintPromptEn';
import { allPoolTerms } from '../routes/wordPool';

// Vercel 등에서 값을 안 채운 환경변수는 undefined가 아니라 빈 문자열로 온다.
// ??는 ""를 "값 있음"으로 쳐서 기본값으로 안 넘어가므로 ||를 쓴다
// (CLAUDE.md에 적힌 것과 같은 함정 — propose.mjs도 같은 이유로 ||를 쓴다).
const BASE_URL = process.env.BOT_BASE_URL || 'https://api.groq.com/openai/v1';
const API_KEY = process.env.BOT_API_KEY ?? '';
const MODEL = process.env.BOT_MODEL || 'openai/gpt-oss-120b';

// override 없이 callBot()을 부를 때 실제로 쓰이는 모델 이름. autoPlay.ts가 이슈에
// "어떤 모델이 추측했는지"를 항상 남기려고(override가 없을 때도) 가져다 쓴다(2026-09-18).
export const DEFAULT_MODEL = MODEL;

export interface Hint {
  text: string;
  /** 무엇에 대해 말했는지 기록용 라벨. 생성 제약이 아니라 사후 분석용이다. */
  angle: string;
}

export interface HintRound {
  /** 이 단어를 들으면 바로 떠오르는 결정적 특징들 — 묘사에서 실제로 제외됐는지 검증용. */
  banned: string[];
  hints: Hint[];
  /** 실제로 묘사를 만든 모델(예: "groq:openai/gpt-oss-120b") — 앞 모델이 한도에 걸려
   *  대체 모델이 만들었는지 피드백 이슈에 남기려고(2026-09-27). */
  model: string;
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
  /** 미지정 시 'ko'(기존 동작 그대로) — autoPlay.ts/spectate.mjs 등 기존 호출부는
   *  안 넘겨도 그대로 한국어로 동작한다(2026-09-17, 영어 버전 추가). */
  lang?: 'ko' | 'en';
  /** true면 EEA·스위스·영국 이용자 요청이라 제미나이 무료 할당량 모델을 쓰지 않는다
   *  (아래 HINT_CHAIN 주석 참고). 내부 호출(자동플레이 등)은 안 넘기면 된다. */
  restrictedRegion?: boolean;
}

export type GuessJudgement = 'exact' | 'loose' | 'wrong';

// .toLowerCase()가 없으면 영어판에서 "Tambourine"과 "tambourine"이 다른 문자열로
// 취급돼 오답 처리된다(2026-09-17 발견 — 한국어는 대소문자가 없어서 여태 안 드러났다).
const normalize = (s: string): string => String(s ?? '').toLowerCase().replace(/[\s.,!?"'·]/g, '').trim();

// 포함 관계 판정(loose)의 함정 세 가지를 막는다(2026-09-26 — 풀 전수 검사로 한국어
// 89쌍·영어 3쌍 발견):
//  1) 다른 제시어를 댄 추측 — "고래"는 "돌고래"에, "소나무"는 "소"를 품고 있지만
//     둘 다 풀에 있는 다른 단어다. 추측이 풀의 다른 단어(또는 그 동의어)면 오답.
//  2) 한 글자 포함 — "배"가 "배드민턴"·"배추"에 들어 있다. 한국어는 짧은 쪽이 두 글자
//     이상일 때만 loose(경찰/경찰관은 그대로 통과).
//  3) 영어의 철자 포함 — "an"·"ant"가 "elephant"에 들어 있다. 영어는 문자열이 아니라
//     단어 단위로 포함을 본다("a dolphin"·"dolphins"는 dolphin으로 통과).
let poolTerms: Set<string> | null = null;
const isOtherPoolWord = (g: string): boolean => {
  poolTerms ??= new Set(allPoolTerms().map(normalize));
  return poolTerms.has(g);
};
const isLatin = (s: string): boolean => /^[\x00-\x7F]+$/.test(s);
const STOPWORDS = new Set(['a', 'an', 'the']);
const englishWords = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .map(singular);

// 영어 복수형을 단수로(추측·제시어 양쪽에 똑같이 적용). 예전엔 끝의 s만 떼서 "tomatoes"가 "tomatoe"가
// 되어 tomato 정답으로 인정되지 않았다(2026-09-29). -ies→y(berries), -oes·-ches·-shes·-xes→es 떼기,
// 그 밖엔 s 떼기(-ss는 그대로). -oes는 다섯 글자 넘을 때만(shoes·toes를 sho·to로 만들지 않게).
function singular(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if ((w.length > 5 && w.endsWith('oes')) || (w.length > 4 && /(ches|shes|xes)$/.test(w))) return w.slice(0, -2);
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}
const allIn = (a: string[], b: string[]): boolean => a.length > 0 && a.every((w) => b.includes(w));

/**
 * 정답 판정. LLM을 쓰지 않는다 — 플레이어가 직접 입력하므로 문자열 비교면 된다.
 *   exact  정답과 같거나 accept(동의어)에 있음
 *   loose  한쪽이 다른 쪽을 포함 (경찰관/경찰, 골프/골프공) — 단, 위 세 가지 함정 제외
 *   wrong  그 외
 */
export function judgeGuess(word: string, guess: string, accept: string[] = []): GuessJudgement {
  const g = normalize(guess);
  if (!g) return 'wrong';
  const w = normalize(word);
  if (g === w) return 'exact';
  if (accept.some((a) => normalize(a) === g)) return 'exact';
  if (isOtherPoolWord(g)) return 'wrong';
  if (isLatin(word) && isLatin(guess)) {
    const gw = englishWords(guess);
    const ww = englishWords(word);
    return allIn(gw, ww) || allIn(ww, gw) ? 'loose' : 'wrong';
  }
  if (Math.min(g.length, w.length) >= 2 && (g.includes(w) || w.includes(g))) return 'loose';
  return 'wrong';
}

// ── LLM 호출 ───────────────────────────────────────────────────────────

export class LlmError extends Error {
  /** true면 재시도해도 소용없다(키 문제 등) — 호출부가 즉시 포기해야 한다. */
  fatal = false;
  /** HTTP 상태(시간 초과면 0). generateHints()가 다음 모델로 넘어갈지·얼마나 쉴지 정하는 데 쓴다. */
  status?: number;
  /** 하루 한도(TPD·RPD, 제미나이 PerDay 할당량)에 걸린 429 — 한동안 그 모델을 건너뛴다. */
  dailyQuota = false;
  /** 서버가 알려준 재시도 대기 시간(ms). */
  retryAfterMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(res: Response, body: string): number {
  const h = Number(res.headers.get('retry-after'));
  if (Number.isFinite(h) && h > 0) return h * 1000 + 500;
  const m = body.match(/try again in ([\d.]+)\s*s/i);
  if (m) return Number(m[1]) * 1000 + 500;
  return 5000;
}

// callBot()에 override로 다른 엔드포인트를 줄 때 쓴다(2026-09-17 — 자가플레이
// 추측자를 제미나이로 비교 실험할 때). baseUrl 뒤에 슬래시(/)를 붙이지 말 것 —
// callBot()이 `${baseUrl}/chat/completions`처럼 직접 이어 붙인다(propose.mjs에서
// 슬래시 중복으로 404 났던 것과 같은 함정).
export interface BotConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 요청 본문에 더 실을 모델별 옵션(추론 강도 등). 없으면 gpt-oss면 추론 low, 아니면 없음. */
  extraBody?: Record<string, unknown>;
  /** false면 response_format(JSON 모드)을 보내지 않는다 — 지원 안 하는 모델용. 기본 true. */
  jsonMode?: boolean;
  /** 요청할 최대 출력 토큰. 없으면 gpt-oss 2000 / 그 외 4000(아래 상수 참고). */
  maxTokens?: number;
}

async function listModels(baseUrl: string, apiKey: string): Promise<string> {
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
    const data = (await res.json()) as { data?: { id: string }[] };
    const ids = data.data?.map((m) => m.id).sort() ?? [];
    return ids.length ? ids.map((id) => `  ${id}`).join('\n') : '  (목록을 받지 못했다)';
  } catch {
    return '  (목록 조회 실패)';
  }
}

/** gpt-oss 계열은 추론 토큰이 max_tokens 예산을 같이 먹는다 — 예산 부족하면 빈 JSON이 온다. */
const isReasoningModel = (model: string): boolean => /gpt-oss/.test(model);

// Groq(gpt-oss)엔 max_tokens를 2000으로 준다(2026-09-26, 원래 4000). Groq 무료 티어의
// 하루 토큰 한도(TPD 200,000)가 한도 검사 때 요청한 max_tokens까지 잡는 것으로 보여서
// (한도 근처에서 작은 요청은 통과하는데 4000짜리 게임 요청만 계속 막혔다), 실제로는
// 다 쓰지도 않을 예산을 줄였다 — 실측 출력(숨은 추론 포함)은 많아야 약 1,300이었다.
// 그래도 모자라면 Groq가 json_validate_failed로 JSON을 못 만드니, 그때만 4000으로
// 한 번 다시 부른다. 제미나이 등 다른 모델은 이 한도와 무관해서 4000 그대로.
const MAX_TOKENS = 4000;
const REASONING_MAX_TOKENS = 2000;

// export: autoPlay.ts(자가개선 AI 자동플레이)가 같은 재시도·reasoning-model
// 처리 로직을 그대로 재사용한다 — 추측자·소감 LLM 호출도 출제자와 같은 엔드포인트/
// 429 재시도 규칙을 타므로 새로 짤 이유가 없다.
//
// override를 주면 이 호출 하나만 모듈 상단의 BASE_URL/API_KEY/MODEL(=BOT_*) 대신
// 다른 엔드포인트를 쓴다(2026-09-17 — autoPlay.ts가 추측자를 제미나이로 바꿔서
// 비교할 때). 안 주면 지금까지처럼 BOT_* 그대로다.
// patient: 503(일시 과부하)을 몇 분씩 기다려도 되는 배치 호출(자동플레이)에서만 켠다.
// 실제 게임 요청은 Vercel 함수 타임아웃이 먼저 와서 오래 못 기다린다 — 기본값은
// 지금까지처럼 짧게 6번.
export interface CallOptions {
  patient?: boolean;
  /** 429·503을 기다리지 않고 바로 LlmError로 던진다 — 실제 게임 요청에서 다음 모델로
   *  넘어가려고(2026-09-27, generateHints()의 모델 체인). 하루 한도가 걸리면 retry-after가
   *  "7분 뒤" 같은 값이라 기다리는 동안 Vercel 함수가 먼저 끝나 버린다. */
  failFast?: boolean;
  /** 요청 하나의 제한 시간(ms). 넘으면 status 0인 LlmError. 없으면 제한 없음. */
  timeoutMs?: number;
}

const isDailyQuota = (body: string): boolean => /per day|PerDay|\(TPD\)|\(RPD\)/i.test(body);

export async function callBot(
  system: string,
  user: string,
  override?: BotConfig,
  opts: CallOptions = {},
): Promise<string> {
  const baseUrl = override?.baseUrl ?? BASE_URL;
  const apiKey = override?.apiKey ?? API_KEY;
  const model = override?.model ?? MODEL;

  let maxTokens = override?.maxTokens ?? (isReasoningModel(model) ? REASONING_MAX_TOKENS : MAX_TOKENS);
  // 잘렸을 때 한 번 더 부를 상한 — 모델에 maxTokens를 따로 준 경우(분당 출력 한도가
  // 작은 모델 등)는 그 값이 상한이라 늘리지 않는다.
  const maxTokensCap = override?.maxTokens ?? MAX_TOKENS;
  const extraBody = override?.extraBody ?? (isReasoningModel(model) ? { reasoning_effort: 'low', reasoning_format: 'hidden' } : {});
  // temperature 0.7(2026-09-27, 원래 0.9) — 0.9에선 "술안주로도 괜찮은 걸음걸이",
  // "가족 중 가장 큰 몸집" 같은 지어낸·어색한 묘사가 잦았다(사람 피드백 #157·#162).
  // 판마다 다른 묘사는 제시어·금지어 선택만으로도 충분히 달라져서 다양성 손해는 작다.
  const buildBody = (): string =>
    JSON.stringify({
      model,
      temperature: 0.7,
      max_tokens: maxTokens,
      ...(override?.jsonMode === false ? {} : { response_format: { type: 'json_object' } }),
      ...extraBody,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: buildBody(),
        ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
      });
    } catch (e) {
      const err = new LlmError(`LLM 요청 실패(시간 초과 또는 네트워크, ${model}): ${e instanceof Error ? e.message : String(e)}`);
      err.status = 0;
      throw err;
    }
    if (res.ok) {
      const data = (await res.json()) as {
        choices?: { message?: { content?: string }; finish_reason?: string }[];
      };
      const content = data.choices?.[0]?.message?.content?.trim() ?? '';
      // 추론 도중 예산이 끊기면 에러 대신 빈 내용 + finish_reason "length"로 올 수도 있다.
      if (!content && data.choices?.[0]?.finish_reason === 'length' && maxTokens < maxTokensCap) {
        maxTokens = maxTokensCap;
        continue;
      }
      return content;
    }

    const text = await res.text();

    if (opts.failFast && (res.status === 429 || res.status === 503)) {
      const err = new LlmError(`LLM ${res.status}(${model}): ${text.replace(/org_\w+/, 'org_…').slice(0, 300)}`);
      err.status = res.status;
      err.dailyQuota = res.status === 429 && isDailyQuota(text);
      err.retryAfterMs = retryAfterMs(res, text);
      throw err;
    }

    // 제미나이 503엔 retry-after가 안 실려 와서 5초 고정 대기 6번(~30초)으로는 과부하
    // 시간대(KST 새벽 = 미국 낮)를 못 버텼다(2026-09-26 — 9/24~26 새벽 제미나이 판이
    // 3번 연속 사라짐). propose.mjs와 같은 지수 백오프(5→10→20→40→60초, 8회, 최대 약 5분).
    if (res.status === 503 && opts.patient && attempt <= 8) {
      await sleep(Math.min(5000 * 2 ** (attempt - 1), 60000));
      continue;
    }
    // 429는 무료 티어 TPM/RPM 한도, 503은 제미나이 쪽에서 흔한 "일시적 과부하"
    // (propose.mjs의 503 재시도와 같은 이유, 2026-09-17) — 둘 다 같은 방식으로 기다렸다 이어간다.
    if ((res.status === 429 || res.status === 503) && attempt <= 6) {
      await sleep(retryAfterMs(res, text));
      continue;
    }
    // 없는 모델(HINT_MODEL_CHAIN 오타 등)은 다시 불러도 소용없다 — fatal로 던져서
    // generateHints()가 그 모델을 한 시간 쉬게 한다(2026-09-28, 예전엔 일반 Error라 매 판
    // 그 모델부터 다시 부르고 모델 목록까지 조회해 매번 느려졌다). 제미나이는 404 본문에
    // model_not_found 대신 "not found"를 쓴다.
    if (res.status === 404 && /model_not_found|not found/i.test(text)) {
      const err = new LlmError(`모델 "${model}" 을(를) 이 키로 쓸 수 없다.\n사용 가능한 모델:\n${await listModels(baseUrl, apiKey)}`);
      err.status = 404;
      err.fatal = true;
      throw err;
    }
    if (text.includes('json_validate_failed')) {
      // 줄여둔 예산(REASONING_MAX_TOKENS)이 모자랐을 수 있다 — 원래 예산으로 한 번만 더.
      if (maxTokens < maxTokensCap) {
        maxTokens = maxTokensCap;
        continue;
      }
      throw new Error(
        `JSON 생성 실패. 추론 토큰이 max_tokens 를 다 먹었을 가능성이 크다 — ` +
          `max_tokens 를 올리거나 reasoning_effort 를 낮춰볼 것.\n${text.slice(0, 300)}`,
      );
    }
    const err = new LlmError(`LLM ${res.status}(${model}): ${text.slice(0, 300)}`);
    err.status = res.status;
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
// hintSystem 은 hintPrompt.ts(한국어)·hintPromptEn.ts(영어)로 옮겼다(자가개선
// 워크플로가 hintPrompt.ts만 건드리게 하려고 — hintPromptEn.ts는 그 대상이 아니다).

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

// hintUser의 영어판. hintPromptEn.ts와 짝이다 — 시스템 프롬프트만 영어고 유저
// 메시지는 한국어면 모델이 뒤섞어 응답할 위험이 있어 둘 다 언어를 맞춘다.
function hintUserEn(
  word: string,
  round: 1 | 2,
  hintCount: number,
  previousHints?: Hint[],
  wrongGuess?: string,
): string {
  if (round === 1) {
    return `Target word: ${word}\n\nWrite ${hintCount} clues.`;
  }
  const prev = (previousHints ?? []).map((h) => `- ${h.text}`).join('\n');
  return (
    `Target word: ${word}\n\nClues already given in round 1 (don't repeat these):\n${prev}\n\n` +
    `The round 1 guess was "${wrongGuess}" and it was wrong. Avoid clues that would lead back to` +
    ` that same guess, but don't directly say "it's not ${wrongGuess}".\n\n` +
    `Write ${hintCount} round 2 clues.`
  );
}

// ── 출제 모델 체인 ─────────────────────────────────────────────────────
// 2026-09-27: 묘사를 한 모델(Groq gpt-oss-120b)에만 맡기니, 그 모델의 하루 토큰
// 한도(TPD 200,000)가 바닥나면 게임 전체가 멈췄다(2026-09-26에 두 번). 무료 한도는
// 모델마다 따로 잡히므로(Groq는 모델별, 제미나이는 프로젝트의 모델별), 품질 순으로
// 여러 모델을 줄 세워 두고 앞 모델이 한도·과부하·시간 초과면 다음 모델로 넘긴다.
// 순서는 같은 프롬프트·같은 단어로 비교한 결과(사실성·금지어 준수·속도)를 따른다(아래
// DEFAULT_HINT_CHAIN) —
// HINT_MODEL_CHAIN 환경변수("groq:모델,gemini:모델,...")로 코드 수정 없이 바꿀 수 있다.
//
// ⚠️ 제미나이 API 무료 할당량은 EEA·스위스·영국 이용자에게 서비스하는 데 쓸 수 없다
// (Gemini API 추가 약관 — 그 지역은 유료 서비스만). 그래서 제미나이 항목엔
// eeaRestricted를 달고, game.ts가 Vercel의 접속 국가 헤더로 그 지역 요청이면 건너뛴다.
// 자동플레이·자가개선처럼 이용자에게 서비스하는 게 아닌 내부 호출은 해당 없음.
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
// 제미나이 키: 전용 GEMINI_API_KEY가 없으면 자가개선용 SELFIMPROVE_BOT_API_KEY를 재사용.
// 할당량은 모델별이라 자가개선이 쓰는 gemini-3.8-flash(하루 20회)와 겹치지 않는다 —
// 그래서 그 모델은 체인에 넣지 않는다.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.SELFIMPROVE_BOT_API_KEY || '';

export interface HintProvider extends BotConfig {
  /** 로그·피드백 이슈에 남길 이름(예: "groq:openai/gpt-oss-120b"). */
  label: string;
  /** EEA·스위스·영국 이용자 요청엔 쓰지 않는다(제미나이 무료 할당량 약관). */
  eeaRestricted: boolean;
}

// 모델별 요청 옵션. 비교 테스트(2026-09-27)에서 확인한 값:
//  - gpt-oss: 추론 low(기본 동작, callBot이 알아서 붙인다).
//  - qwen3.8-27b: 추론을 끄고(none), 분당 출력 1,000토큰 한도라 max_tokens 900.
//  - 제미나이 flash-lite: 추론 없는 가벼운 모델이라 옵션 없음.
function toProvider(spec: string): HintProvider | null {
  const [vendor, ...rest] = spec.trim().split(':');
  const model = rest.join(':');
  if (!model) return null;
  if (vendor === 'groq') {
    const qwen = /qwen/i.test(model);
    return {
      label: `groq:${model}`,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      model,
      eeaRestricted: false,
      ...(qwen ? { extraBody: { reasoning_effort: 'none' }, maxTokens: 900 } : {}),
    };
  }
  if (vendor === 'gemini') {
    return { label: `gemini:${model}`, baseUrl: GEMINI_BASE_URL, apiKey: GEMINI_API_KEY, model, eeaRestricted: true };
  }
  return null;
}

// 기본 순서 — 2026-09-27 비교 테스트(같은 프롬프트, 문제 단어 6개, 1라운드):
//  1) gemini-3.1-flash-lite  6/6 성공, 평균 3.5초 — 한국어가 자연스럽고 틀린 말이 거의 없음
//  2) gemini-3.5-flash-lite  5/6, 2.0초 — 1)과 비슷한 품질. 원래 1순위였는데 테스트에서
//     한 번 시간 초과, 직후 실제 호출에선 2분 넘게 응답이 없어서 응답이 안정적인 3.1을 앞에 뒀다
//  3) groq gpt-oss-120b      6/6, 1.1초 — 보통(틀린 말이 섞임). 원래 유일한 출제자였다
//  4) groq gpt-oss-20b       6/6, 0.7초 — 틀린 말이 많음. 게임이 멈추는 것보단 나은 예비
//  5) groq qwen3.8-27b       6/6, 0.8초 — 이상한 문장이 많고 분당 출력 1,000토큰 한도
// 제외: gemini-3.5-flash(품질 최고지만 평균 32초·과부하 잦음), gemini-3.7-flash·
// gemma-4-31b(과부하·내부 오류로 0/6), gemini-3.8-flash(자가개선 전용, 하루 20회).
const DEFAULT_HINT_CHAIN = [
  'gemini:gemini-3.1-flash-lite',
  'gemini:gemini-3.5-flash-lite',
  `groq:${MODEL}`,
  'groq:openai/gpt-oss-20b',
  'groq:qwen/qwen3.8-27b',
].join(',');

export const HINT_CHAIN: HintProvider[] = (process.env.HINT_MODEL_CHAIN || DEFAULT_HINT_CHAIN)
  .split(',')
  .map(toProvider)
  .filter((p): p is HintProvider => !!p && !!p.apiKey);

// 한도·과부하에 걸린 모델은 잠시 건너뛴다 — 서버리스라도 같은 인스턴스가 연달아
// 요청을 받는 동안엔 매번 막힌 모델에 먼저 두드리는 왕복을 아낄 수 있다.
const cooldownUntil = new Map<string, number>();
function cooldownFor(e: unknown): number {
  if (!(e instanceof LlmError)) return 0; // 파싱 실패 등 — 모델 문제라기보다 그 한 번의 답이 이상했던 것
  if (e.fatal) return 60 * 60_000; // 키 문제
  if (e.status === 429) return e.dailyQuota ? 30 * 60_000 : Math.min(Math.max(e.retryAfterMs ?? 20_000, 5_000), 120_000);
  // 503(과부하)은 1초 안에 바로 오니 짧게만 쉰다 — 제미나이 flash-lite가 미국 낮 시간대에
  // 자주 503을 내는데(2026-09-28), 60초씩 쉬면 그 사이 판이 전부 품질이 낮은 gpt-oss로
  // 갔다(사람 피드백 #183~#190). 무응답(0)·그 밖의 5xx는 기다린 비용이 커서 60초 그대로.
  if (e.status === 503) return 10_000;
  if (e.status === 0 || (e.status ?? 0) >= 500) return 60_000;
  return 0;
}

// 게임 요청 하나가 모델 체인을 도는 데 쓸 총 시간 — Vercel 함수 제한(vercel.json의
// maxDuration 60초) 안에서 응답을 돌려줘야 한다. 모델 하나엔 최대 8초 — 체인의 모델들은
// 보통 1~4초에 답한다(비교 테스트). 제미나이가 가끔 응답 없이 멈춰서(2026-09-27 실측)
// 오래 기다리지 않고 다음으로 넘긴다.
const PER_MODEL_TIMEOUT_MS = 8_000;
const CHAIN_BUDGET_MS = 45_000;

/**
 * 묘사 생성. 라운드당 LLM 호출 1번(기획서 v2 — "봇을 5번 부르지 않는다") — 단, 앞
 * 모델이 한도·과부하·오류면 체인의 다음 모델로 한 번씩 더 부른다.
 * round === 2 면 previousHints·wrongGuess 가 필요하다.
 */
export async function generateHints(input: GenerateHintsInput): Promise<HintRound> {
  const { word, category, round, hintCount, previousHints, wrongGuess, lang } = input;
  if (round === 2 && (!previousHints || wrongGuess === undefined)) {
    throw new Error('2라운드는 previousHints 와 wrongGuess 가 필요하다.');
  }

  const isEn = (lang ?? 'ko') === 'en';
  const system = isEn ? hintSystemEn(round, category, hintCount) : hintSystemKo(round, category, hintCount);
  const user = isEn
    ? hintUserEn(word, round, hintCount, previousHints, wrongGuess)
    : hintUser(word, round, hintCount, previousHints, wrongGuess);

  const usable = HINT_CHAIN.filter((p) => !(input.restrictedRegion && p.eeaRestricted));
  const now = Date.now();
  // 쉬는 중인 모델은 뒤로 미룬다(아예 빼진 않는다 — 전부 쉬는 중이면 그래도 시도해 본다).
  const ordered = [...usable.filter((p) => (cooldownUntil.get(p.label) ?? 0) <= now), ...usable.filter((p) => (cooldownUntil.get(p.label) ?? 0) > now)];
  if (!ordered.length) throw new Error('쓸 수 있는 출제 모델이 없다(API 키 설정을 확인할 것).');

  const started = Date.now();
  const errors: string[] = [];
  for (const provider of ordered) {
    if (errors.length && Date.now() - started > CHAIN_BUDGET_MS) break;
    try {
      const raw = await callBot(system, user, provider, { failFast: true, timeoutMs: PER_MODEL_TIMEOUT_MS });
      return { ...parseHintRound(raw, hintCount, word), model: provider.label };
    } catch (e) {
      const pause = cooldownFor(e);
      if (pause) cooldownUntil.set(provider.label, Date.now() + pause);
      errors.push(`${provider.label}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
    }
  }
  throw new Error(`모든 출제 모델이 실패했다 — ${errors.join(' / ')}`);
}

// 묘사에 제시어가 그대로 들어갔는지 — 프롬프트로 금지해도 가끔 샌다(2026-09-28 #185 낚시 →
// "낚시터에 놓인 작은 의자"). 판정은 judgeGuess와 같은 기준: 한국어는 두 글자 이상만
// 글자 포함으로("배"는 "배고픈"에 걸리니 제외), 영어는 단어 단위로.
export function leaksWord(hint: string, word: string): boolean {
  if (isLatin(word)) return allIn(englishWords(word), englishWords(hint));
  const w = normalize(word);
  return w.length >= 2 && normalize(hint).includes(w);
}

function parseHintRound(raw: string, hintCount: number, word: string): Omit<HintRound, 'model'> {
  const out = parseJson<{ banned?: unknown; hints?: unknown }>(raw, {});

  const hints = out.hints;
  if (!Array.isArray(hints) || !hints.length) {
    throw new Error('묘사 파싱 실패: ' + raw.slice(0, 300));
  }

  // 모델이 hintCount보다 많이 만들면서 뒷부분을 text 없이 채우는 경우가 있다
  // (2026-09-22, 이슈 #115 — 커터칼 1라운드가 5개가 아니라 "5개 실제 + 빈 문자열
  // 3개"로 8개가 왔다. roundHintCounts가 그대로 8을 기록해 결과 화면 힌트 로그에
  // 빈 줄 3개가 끼어들었다). 빈 텍스트를 걸러내고 hintCount개로 자른다 — 그래도
  // 부족하면(모델이 진짜 부족하게 만든 경우) 파싱 실패로 취급해 재시도를 유도한다.
  const cleaned = (hints as { text?: unknown; angle?: unknown }[])
    .map((h) => ({ text: String(h.text ?? '').trim(), angle: String(h.angle ?? '?').slice(0, 20) }))
    .filter((h) => h.text.length > 0);
  // 제시어가 샌 묘사는 버린다 — 그래서 모자라면 아래 파싱 실패로 체인의 다음 모델이 다시
  // 만든다(LlmError가 아니라 그 모델을 쉬게 하진 않는다).
  const safe = cleaned.filter((h) => !leaksWord(h.text, word));
  if (safe.length < hintCount) {
    throw new Error(
      `묘사 파싱 실패: ${hintCount}개 요청했는데 유효한 게 ${safe.length}개뿐(원본 ${hints.length}개, 제시어 노출 ${cleaned.length - safe.length}개). ` +
        raw.slice(0, 300),
    );
  }

  return {
    banned: Array.isArray(out.banned) ? out.banned.map(String) : [],
    hints: safe.slice(0, hintCount),
  };
}
