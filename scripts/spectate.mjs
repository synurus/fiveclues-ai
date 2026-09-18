#!/usr/bin/env node
// 관전 모드 — 사람 없이 묘사를 생성하고, 자동 추측자가 맞히는지로 난이도를 잰다.
// 기획서 v2 기준. 사람 라벨(결정적/무쓸모)은 못 얻지만 정답률은 무인으로 나온다.
//
// 묘사 생성(hintSystem)·정답 판정(judgeGuess)은 프로덕션 코드
// (apps/backend/src/bot/wordGuessBot.ts, hintPrompt.ts)를 ts-node로 그 자리에서
// require한다 — 복제본이 아니다(2026-09-18 이전엔 이 파일 안에 프롬프트를 통째로
// 복제해 갖고 있었는데, hintPrompt.ts가 바뀔 때마다 안 따라와서 실측 결과가 실제
// 프로덕션 프롬프트와 다른 걸 재는 상태로 방치돼 있었다). 자동 추측자(guessSystem)만
// 이 파일 고유다 — 프로덕션엔 애초에 AI 추측자가 없다(사람이 직접 추측을 입력한다).
//
//   DRY=1 node scripts/spectate.mjs     LLM 없이 배선만 확인
//   node scripts/spectate.mjs           한 판
//   GAMES=20 node scripts/spectate.mjs  스무 판 (세대 비교 최소 단위)
//
// ts-node(레포 devDependency, 백엔드도 dev 서버에 그대로 쓴다)로 apps/backend를
// require하는 것 말고는 의존성이 없다(Node 22+ 내장 fetch). 결과는 runs/ 에
// JSONL로 떨어진다.
//
// 환경변수: BOT_BASE_URL, BOT_API_KEY, BOT_MODEL  (OpenAI 호환 엔드포인트)
//   Groq     https://api.groq.com/openai/v1   (모델: openai/gpt-oss-120b)
//   Cerebras https://api.cerebras.ai/v1
//   로컬     http://localhost:11434/v1   (Ollama)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

// 레포 루트의 .env 를 읽는다(Node 21.7+ 내장, 의존성 없음).
// 셸 창을 새로 열 때마다 $env: 로 키를 다시 넣지 않아도 된다. .env 는 .gitignore 에 있다.
// wordGuessBot.ts 자신도 dotenv/config로 같은 파일을 또 읽지만, 여기서 먼저 채워두면
// 그쪽은 이미 있는 값을 덮어쓰지 않으니 순서 문제 없다.
if (existsSync('.env')) process.loadEnvFile('.env');

// apps/backend는 tsconfig가 module:nodenext — 같은 설정으로 트랜스파일해야
// require() 인터롭이 백엔드가 실제로 도는 방식과 어긋나지 않는다. transpileOnly라
// 타입체크는 안 한다(JS에서 부르는 거라 어차피 타입이 안 먹는다) — 문법만 변환.
const require = createRequire(import.meta.url);
require('ts-node').register({ transpileOnly: true, project: 'apps/backend/tsconfig.json' });
const { generateHints, judgeGuess } = require('../apps/backend/src/bot/wordGuessBot.ts');

const CFG = {
  baseUrl: process.env.BOT_BASE_URL ?? 'https://api.groq.com/openai/v1',
  apiKey: process.env.BOT_API_KEY ?? '',
  model: process.env.BOT_MODEL ?? 'openai/gpt-oss-120b',
  hints: Number(process.env.HINTS ?? 5), // 라운드당 묘사 개수
  games: Number(process.env.GAMES ?? 1),
  dry: process.env.DRY === '1',
};

// 목표: 1라운드 정답률 25~35% (기획서 v2 §8)
const TARGET_BAND = [25, 35];

const WORDS = JSON.parse(await readFile(new URL('./words.json', import.meta.url), 'utf8'));

// SEED 를 주면 매 실행이 같은 제시어 순서를 쓴다.
// 세대끼리 다른 단어로 재면 단어 난이도 편차가 프롬프트 효과를 덮어버린다.
let _seed = Number(process.env.SEED ?? 0);
const rnd = () => {
  if (!_seed) return Math.random();
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
};
const pick = (a) => a[Math.floor(rnd() * a.length)];


// 정답 판정은 judgeGuess(wordGuessBot.ts, 위 require)를 그대로 쓴다 — 이 도구가
// 재는 정답률이 실제 프로덕션 판정 기준과 어긋나면 지표 자체가 무의미해진다.

// ── LLM ────────────────────────────────────────────────────────────────
let calls = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 서버가 "몇 초 뒤 재시도"를 알려준다. 헤더 우선, 없으면 메시지에서 긁는다.
function retryAfterMs(res, body) {
  const h = Number(res.headers.get('retry-after'));
  if (Number.isFinite(h) && h > 0) return h * 1000 + 500;
  const m = body.match(/try again in ([\d.]+)\s*s/i);
  if (m) return Number(m[1]) * 1000 + 500;
  return 5000;
}

async function llm(system, user) {
  calls++;
  if (CFG.dry) {
    return JSON.stringify({
      banned: ['[DRY] 결정적 특징'],
      hints: Array.from({ length: CFG.hints }, (_, i) => ({
        text: `[DRY] 묘사 ${calls}-${i + 1}`,
        angle: ['인상·평가', '마주치는 상황', '따라오는 것'][i % 3],
      })),
      guess: '사자',
    });
  }

  // gpt-oss 계열은 추론 모델이라 추론 토큰이 max_tokens 예산을 같이 먹는다.
  // 예산이 모자라면 최종 답이 통째로 잘려 빈 응답이 나오고 JSON 검증이 실패한다.
  // 그리고 JSON 모드에서는 reasoning_format 을 parsed/hidden 으로 둬야 한다.
  const isGptOss = /gpt-oss/.test(CFG.model);
  const body = JSON.stringify({
    model: CFG.model,
    temperature: 0.9,
    max_tokens: 4000,
    response_format: { type: 'json_object' },
    ...(isGptOss ? { reasoning_effort: 'low', reasoning_format: 'hidden' } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${CFG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.apiKey}` },
      body,
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content?.trim() ?? '';
    }

    const text = await res.text();

    // 무료 티어는 분당 토큰(TPM) 한도가 빡빡하다. 서버가 알려준 만큼 기다렸다 이어서 한다.
    if (res.status === 429 && attempt <= 6) {
      const ms = retryAfterMs(res, text);
      process.stdout.write(`  … 한도 대기 ${(ms / 1000).toFixed(1)}초\n`);
      await sleep(ms);
      continue;
    }
    // 모델 이름은 제공자 사정으로 자주 바뀐다. 404면 이 키로 쓸 수 있는 목록을 바로 보여준다.
    if (res.status === 404 && text.includes('model_not_found')) {
      throw new Error(`모델 "${CFG.model}" 을(를) 이 키로 쓸 수 없다.\n사용 가능한 모델:\n${await listModels()}`);
    }
    if (text.includes('json_validate_failed')) {
      throw new Error(
        `JSON 생성 실패. 추론 토큰이 max_tokens 를 다 먹었을 가능성이 크다 — ` +
          `max_tokens 를 올리거나 reasoning_effort 를 낮춰볼 것.\n${text.slice(0, 300)}`,
      );
    }
    const err = new Error(`LLM ${res.status}: ${text.slice(0, 300)}`);
    if (res.status === 401 || res.status === 403) err.fatal = true; // 키 문제면 20판 반복해봐야 똑같다
    throw err;
  }
}

async function listModels() {
  try {
    const res = await fetch(`${CFG.baseUrl}/models`, {
      headers: { authorization: `Bearer ${CFG.apiKey}` },
    });
    const ids = (await res.json()).data?.map((m) => m.id).sort() ?? [];
    return ids.length ? ids.map((id) => `  ${id}`).join('\n') : '  (목록을 받지 못했다)';
  } catch {
    return '  (목록 조회 실패)';
  }
}

// 무료 티어 모델은 response_format 을 줘도 JSON 을 어기는 일이 잦다.
function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* 무시 */ } }
    return fallback;
  }
}

// ── 프롬프트 ───────────────────────────────────────────────────────────
// 묘사 생성(hintSystem)은 apps/backend/src/bot/hintPrompt.ts를 그대로 쓴다(위
// require 참고) — 여긴 자동 추측자 프롬프트만 있다. 프로덕션 프롬프트를 고치고
// 싶으면 이 파일이 아니라 hintPrompt.ts를 고쳐라.

// 주제를 추측자에게 주지 않는다 — 실제 게임에서 플레이어는 주제를 못 본다(기획서 v2).
// 주제를 주면 후보가 900여 개에서 수십 개로 줄어서, 묘사가 아니라 주제가 정답을 만든다.
// 출제자에게는 여전히 준다. "주제 안의 다른 것에도 들어맞게"가 난이도의 핵심이라서.
const guessSystem = () => `
너는 한국어 낱말 맞히기 게임의 참가자다. 묘사만 보고 제시어를 추측한다.
설명 없이 한국어 명사 하나만 답한다.

JSON만 출력한다: {"guess":"단어"}`.trim();

// wrongGuess 처리(1라운드 오답을 직접 부정하지 않고 존재만 알려주는 것 등)는
// generateHints()가 내부에서 hintUser()로 만든다 — 여기선 그냥 넘기기만 한다.
async function makeHints(word, category, round, previous, wrongGuess) {
  if (CFG.dry) {
    calls++;
    return {
      banned: ['[DRY] 결정적 특징'],
      hints: Array.from({ length: CFG.hints }, (_, i) => ({
        text: `[DRY] 묘사 ${calls}-${i + 1}`,
        angle: ['인상·평가', '마주치는 상황', '따라오는 것'][i % 3],
        round,
      })),
    };
  }
  calls++;
  const { banned, hints } = await generateHints({
    word, category, round, hintCount: CFG.hints,
    previousHints: previous, wrongGuess,
  });
  return { banned, hints: hints.map((h) => ({ ...h, round })) };
}

async function autoGuess(hints) {
  const raw = await llm(guessSystem(), `묘사:\n${hints.map((h) => `- ${h.text}`).join('\n')}`);
  return String(parseJson(raw, {}).guess ?? '');
}

// ── 한 판 ──────────────────────────────────────────────────────────────
async function playGame(gameNo, used) {
  const pool = WORDS.filter((w) => !used.has(w.word));
  const { word, category } = pick(pool.length ? pool : WORDS);
  used.add(word);

  const accept = WORDS.find((x) => x.word === word)?.accept ?? [];
  const { hints: r1, banned: banned1 } = await makeHints(word, category, 1, []);
  r1.forEach((h) => console.log(`  1R [${h.angle}] ${h.text}`));
  const guess1 = await autoGuess(r1);
  const v1 = judgeGuess(word, guess1, accept);
  const solved1 = v1 === 'exact';
  console.log(`  → 1차 추측 "${guess1}" ${v1 === 'exact' ? '정답' : v1 === 'loose' ? '준정답' : '오답'}`);

  let r2 = [], guess2 = null, solved2 = false, v2 = null;
  if (!solved1) {
    ({ hints: r2 } = await makeHints(word, category, 2, r1, guess1));
    r2.forEach((h) => console.log(`  2R [${h.angle}] ${h.text}`));
    guess2 = await autoGuess([...r1, ...r2]);
    v2 = judgeGuess(word, guess2, accept);
    solved2 = v2 === 'exact';
    console.log(`  → 2차 추측 "${guess2}" ${v2 === 'exact' ? '정답' : v2 === 'loose' ? '준정답' : '오답'}`);
  }

  const loose1 = v1 === 'loose';
  const loose2 = v2 === 'loose';

  console.log(`  제시어 ${word} (${category}) — ${solved1 ? '1라운드' : solved2 ? '2라운드' : '실패'}\n`);

  return {
    gameNo, word, category,
    hints: [...r1, ...r2],
    banned: banned1,
    guess1, guess2, solved1, solved2, verdict1: v1, verdict2: v2,
    outcome: solved1 ? 'round1' : solved2 ? 'round2' : 'fail',
    looseOutcome: solved1 || loose1 ? 'round1' : solved2 || loose2 ? 'round2' : 'fail',
  };
}

// ── 실행 ───────────────────────────────────────────────────────────────
const started = Date.now();
const results = [];
const used = new Set();

if (!CFG.dry && !CFG.apiKey) {
  console.error(
    'BOT_API_KEY 가 비어 있다.\n' +
      '레포 루트에 .env 를 만들고 아래처럼 채운다:\n' +
      '  BOT_BASE_URL=https://api.groq.com/openai/v1\n' +
      '  BOT_API_KEY=gsk_...\n' +
      '  BOT_MODEL=openai/gpt-oss-120b\n' +
      '(배선만 확인하려면 DRY=1)',
  );
  process.exit(1);
}

console.log(
  `제시어 풀 ${WORDS.length}개 · 라운드당 묘사 ${CFG.hints}개${CFG.dry ? ' · DRY' : ''} · ${CFG.model}` +
    (process.env.SEED ? ` · SEED=${process.env.SEED}` : ' · SEED 없음(매번 다른 단어)'),
);

for (let i = 1; i <= CFG.games; i++) {
  console.log(`\n━━ ${i}/${CFG.games} 판 ━━`);
  try {
    results.push(await playGame(i, used));
  } catch (e) {
    console.error(`  실패: ${e.message}`);
    if (e.fatal) {
      console.error('\n키 문제로 보인다. 중단한다.');
      break;
    }
  }
}

const n = results.length;
if (n) {
  const r1 = results.filter((r) => r.outcome === 'round1').length;
  const r2 = results.filter((r) => r.outcome === 'round2').length;
  const l1 = results.filter((r) => r.looseOutcome === 'round1').length;
  const l2 = results.filter((r) => r.looseOutcome === 'round2').length;
  const rate1 = (r1 / n) * 100;
  const styles = {};
  for (const r of results) for (const h of r.hints) styles[h.angle] = (styles[h.angle] ?? 0) + 1;

  const verdict =
    rate1 < TARGET_BAND[0] ? '묘사가 너무 어렵다 — 더 구체적으로'
    : rate1 > TARGET_BAND[1] ? '묘사가 너무 쉽다 — 더 모호하게'
    : '목표 밴드 안';

  console.log('━'.repeat(46));
  console.log(`판 수           ${n}`);
  console.log(`1라운드 정답률  ${rate1.toFixed(0)}%  (${r1}/${n})   목표 ${TARGET_BAND[0]}~${TARGET_BAND[1]}% → ${verdict}`);
  console.log(`최종 정답률     ${(((r1 + r2) / n) * 100).toFixed(0)}%  (${r1 + r2}/${n})`);
  console.log(`  └ 준정답 포함  1R ${((l1 / n) * 100).toFixed(0)}%  최종 ${(((l1 + l2) / n) * 100).toFixed(0)}%   (경찰관/경찰 같은 포함관계)`);
  console.log(`실패            ${n - l1 - l2}`);
  console.log(`묘사 소재 분포  ${JSON.stringify(styles)}`);
  console.log(`LLM 호출 ${calls}회 · ${((Date.now() - started) / 1000).toFixed(0)}초`);
  console.log(`\n⚠️ 판이 적으면 이 숫자는 운과 구분되지 않는다. 세대 비교는 최소 20판부터.`);

  await mkdir('runs', { recursive: true });
  const path = `runs/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  await writeFile(path, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`기록: ${path}`);
}
