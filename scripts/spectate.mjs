#!/usr/bin/env node
// 관전 모드 — 사람 없이 묘사를 생성하고, 자동 추측자가 맞히는지로 난이도를 잰다.
// 기획서 v2 기준. 사람 라벨(결정적/무쓸모)은 못 얻지만 정답률은 무인으로 나온다.
//
//   DRY=1 node scripts/spectate.mjs     LLM 없이 배선만 확인
//   node scripts/spectate.mjs           한 판
//   GAMES=20 node scripts/spectate.mjs  스무 판 (세대 비교 최소 단위)
//
// 의존성 없음(Node 22+ 내장 fetch). 결과는 runs/ 에 JSONL로 떨어진다.
//
// 환경변수: BOT_BASE_URL, BOT_API_KEY, BOT_MODEL  (OpenAI 호환 엔드포인트)
//   Groq     https://api.groq.com/openai/v1   (모델: openai/gpt-oss-120b)
//   Cerebras https://api.cerebras.ai/v1
//   로컬     http://localhost:11434/v1   (Ollama)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// 레포 루트의 .env 를 읽는다(Node 21.7+ 내장, 의존성 없음).
// 셸 창을 새로 열 때마다 $env: 로 키를 다시 넣지 않아도 된다. .env 는 .gitignore 에 있다.
if (existsSync('.env')) process.loadEnvFile('.env');

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

const STYLES = ['단답형', '문장형', '비유', '용도·기능', '감각', '상황·맥락', '부정형'];

const WORDS = JSON.parse(await readFile(new URL('./words.json', import.meta.url), 'utf8'));

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const norm = (s) => String(s ?? '').replace(/[\s.,!?"'·]/g, '').trim();

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
        style: STYLES[i % STYLES.length],
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
// 여기가 이 프로젝트의 본체다. 지표를 보고 고칠 곳은 사실상 이 두 함수뿐.

const hintSystem = (round) => `
너는 한국어 낱말 맞히기 게임의 출제자다. 제시어를 직접 말하지 않고 묘사 ${CFG.hints}개를 만든다.

[난이도 — 가장 중요하다]
${round === 1
  ? `1번이 가장 모호하고, 번호가 커질수록 조금씩 구체적이 되게 배열한다.
마지막 묘사도 정답을 단정하게 만들지는 않는다.
목표: 이 묘사들만 보고 처음 보는 사람이 맞힐 확률이 약 30%.`
  : `이번은 2라운드다. 1라운드에서 맞히지 못했으므로 **1라운드보다 쉽게** 만든다.
더 구체적으로 가되, 제시어를 그대로 말하지는 않는다.`}

[작업 순서 — 반드시 이 순서로 한다]
1. 먼저 "banned" 를 채운다: 이 단어를 들으면 누구나 바로 떠올리는 **결정적 특징 5개**.
   그 단어를 지목하는 데 가장 강력한 단서들이다.
   (캥거루라면 "뒷다리로 점프", "배에 주머니", "호주" / 달력이라면 "열두 달", "날짜")
2. 그다음 "hints" 를 만든다. **1번에 적은 특징은 하나도 쓰지 않는다.**
   바꿔 말한 것, 비유로 돌려 말한 것도 안 된다.

이게 이 작업의 핵심이다. 결정적 특징을 다 빼고도 그럴듯한 묘사를 만드는 것이 목표다.

[금지]
- 제시어와 그 일부 글자.
- **제시어가 속한 무리를 가리키는 총칭.** "동물·과일·채소·기계·도구·생물·열매·탈것·악기"
  같은 단어는 어떤 것도 쓰지 않는다. 범주는 플레이어가 묘사에서 스스로 추론해야 한다.
- **한 문장에 결정적 속성을 두 개 이상 몰아넣는 것.** 색·모양·질감·용도 중 한 문장에는
  하나만 담는다.

[세트 전체 난이도]
**${CFG.hints}개를 전부 읽은 뒤에도 후보가 2~3개는 남아 있어야 한다.**
마지막 묘사까지 본 사람이 "이것 아니면 저것"에서 고민하는 상태를 목표로 한다.

[형식]
- 각 묘사는 한 문장, 30자 이내.
- ${CFG.hints}개의 스타일을 서로 다르게 한다. **아래 목록의 단어를 글자 그대로** 쓴다.
  새 스타일 이름을 지어내지 않는다:
  ${STYLES.join(' / ')}

JSON만 출력한다. hints 는 모호한 것부터 구체적인 것 순서로 담는다:
{"banned":["결정적 특징5개"],"hints":[{"text":"묘사","style":"스타일"}]}`.trim();

const guessSystem = `
너는 한국어 낱말 맞히기 게임의 참가자다. 묘사만 보고 제시어를 추측한다.
주제나 범주는 주어지지 않는다. 설명 없이 한국어 명사 하나만 답한다.

JSON만 출력한다: {"guess":"단어"}`.trim();

async function makeHints(word, round, previous) {
  const user = round === 1
    ? `제시어: ${word}\n\n묘사 ${CFG.hints}개를 만들어라.`
    : `제시어: ${word}\n\n1라운드에서 이미 나온 묘사(겹치지 말 것):\n` +
      previous.map((h) => `- ${h.text}`).join('\n') +
      `\n\n2라운드 묘사 ${CFG.hints}개를 만들어라.`;
  const raw = await llm(hintSystem(round), user);
  const out = parseJson(raw, {});
  const hints = out.hints;
  if (!Array.isArray(hints) || !hints.length) throw new Error('묘사 파싱 실패');
  return {
    banned: Array.isArray(out.banned) ? out.banned.map(String) : [],
    hints: hints.map((h) => ({ text: String(h.text ?? ''), style: String(h.style ?? '?'), round })),
  };
}

async function autoGuess(hints) {
  const raw = await llm(guessSystem, `묘사:\n${hints.map((h) => `- ${h.text}`).join('\n')}`);
  return String(parseJson(raw, {}).guess ?? '');
}

// ── 한 판 ──────────────────────────────────────────────────────────────
async function playGame(gameNo, used) {
  const pool = WORDS.filter((w) => !used.has(w.word));
  const { word, category } = pick(pool.length ? pool : WORDS);
  used.add(word);

  const { hints: r1, banned: banned1 } = await makeHints(word, 1, []);
  r1.forEach((h) => console.log(`  1R [${h.style}] ${h.text}`));
  const guess1 = await autoGuess(r1);
  const solved1 = norm(guess1) === norm(word);
  console.log(`  → 1차 추측 "${guess1}" ${solved1 ? '정답' : '오답'}`);

  let r2 = [], guess2 = null, solved2 = false;
  if (!solved1) {
    ({ hints: r2 } = await makeHints(word, 2, r1));
    r2.forEach((h) => console.log(`  2R [${h.style}] ${h.text}`));
    guess2 = await autoGuess([...r1, ...r2]);
    solved2 = norm(guess2) === norm(word);
    console.log(`  → 2차 추측 "${guess2}" ${solved2 ? '정답' : '오답'}`);
  }

  const finalGuess = solved1 ? guess1 : guess2;
  // 정답은 아닌데 한쪽이 다른 쪽을 포함하면 표기 문제일 수 있다 (텔레비전/TV 등)
  const nearMiss =
    !solved1 && !solved2 && finalGuess
      ? norm(finalGuess).includes(norm(word)) || norm(word).includes(norm(finalGuess))
      : false;
  if (nearMiss) console.log(`  ⚠ 표기 차이일 수 있음: 정답 "${word}" vs 추측 "${finalGuess}"`);

  console.log(`  제시어 ${word} (${category}) — ${solved1 ? '1라운드' : solved2 ? '2라운드' : '실패'}\n`);

  return {
    gameNo, word, category,
    hints: [...r1, ...r2],
    banned: banned1,
    guess1, guess2, solved1, solved2, nearMiss,
    outcome: solved1 ? 'round1' : solved2 ? 'round2' : 'fail',
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

console.log(`제시어 풀 ${WORDS.length}개 · 라운드당 묘사 ${CFG.hints}개${CFG.dry ? ' · DRY' : ''} · ${CFG.model}`);

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
  const rate1 = (r1 / n) * 100;
  const styles = {};
  for (const r of results) for (const h of r.hints) styles[h.style] = (styles[h.style] ?? 0) + 1;

  const verdict =
    rate1 < TARGET_BAND[0] ? '묘사가 너무 어렵다 — 더 구체적으로'
    : rate1 > TARGET_BAND[1] ? '묘사가 너무 쉽다 — 더 모호하게'
    : '목표 밴드 안';

  console.log('━'.repeat(46));
  console.log(`판 수           ${n}`);
  console.log(`1라운드 정답률  ${rate1.toFixed(0)}%  (${r1}/${n})   목표 ${TARGET_BAND[0]}~${TARGET_BAND[1]}% → ${verdict}`);
  console.log(`최종 정답률     ${(((r1 + r2) / n) * 100).toFixed(0)}%  (${r1 + r2}/${n})`);
  console.log(`실패            ${n - r1 - r2}`);
  console.log(`스타일 분포     ${JSON.stringify(styles)}`);
  if (results.some((r) => r.nearMiss)) console.log(`⚠ 표기 차이 의심 ${results.filter((r) => r.nearMiss).length}건 — JSONL 확인`);
  console.log(`LLM 호출 ${calls}회 · ${((Date.now() - started) / 1000).toFixed(0)}초`);
  console.log(`\n⚠️ 판이 적으면 이 숫자는 운과 구분되지 않는다. 세대 비교는 최소 20판부터.`);

  await mkdir('runs', { recursive: true });
  const path = `runs/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  await writeFile(path, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`기록: ${path}`);
}
