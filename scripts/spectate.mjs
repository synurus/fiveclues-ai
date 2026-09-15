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
//   Groq     https://api.groq.com/openai/v1
//   Cerebras https://api.cerebras.ai/v1
//   로컬     http://localhost:11434/v1   (Ollama)

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const CFG = {
  baseUrl: process.env.BOT_BASE_URL ?? 'https://api.groq.com/openai/v1',
  apiKey: process.env.BOT_API_KEY ?? '',
  model: process.env.BOT_MODEL ?? 'llama-3.3-70b-versatile',
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

async function llm(system, user) {
  calls++;
  if (CFG.dry) {
    return JSON.stringify({
      hints: Array.from({ length: CFG.hints }, (_, i) => ({
        text: `[DRY] 묘사 ${calls}-${i + 1}`,
        style: STYLES[i % STYLES.length],
      })),
      guess: '사자',
    });
  }
  const res = await fetch(`${CFG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.apiKey}` },
    body: JSON.stringify({
      model: CFG.model,
      temperature: 0.9,
      max_tokens: 800,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
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

${round === 1
  ? `목표 난이도: 이 묘사들만 보고 처음 보는 사람이 맞힐 확률이 약 30%가 되게 한다.
너무 쉬우면 첫 줄에서 정답이 나오고, 너무 어려우면 아무 정보도 없다.`
  : `이번은 2라운드다. 1라운드에서 맞히지 못했으므로 **1라운드보다 쉽게** 만든다.
더 구체적으로 가되, 제시어를 그대로 말하지는 않는다.`}

규칙:
- 제시어와 그 일부 글자를 쓰지 않는다.
- 각 묘사는 한 문장, 30자 이내.
- **상위 범주를 직접 말하지 않는다** ("동물이다", "과일이다" 금지).
- ${CFG.hints}개의 스타일을 서로 다르게 한다. 고를 수 있는 스타일:
  ${STYLES.join(' / ')}

JSON만 출력한다:
{"hints":[{"text":"묘사","style":"스타일"}]}`.trim();

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
  const hints = parseJson(raw, {}).hints;
  if (!Array.isArray(hints) || !hints.length) throw new Error('묘사 파싱 실패');
  return hints.map((h) => ({ text: String(h.text ?? ''), style: String(h.style ?? '?'), round }));
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

  const r1 = await makeHints(word, 1, []);
  r1.forEach((h) => console.log(`  1R [${h.style}] ${h.text}`));
  const guess1 = await autoGuess(r1);
  const solved1 = norm(guess1) === norm(word);
  console.log(`  → 1차 추측 "${guess1}" ${solved1 ? '정답' : '오답'}`);

  let r2 = [], guess2 = null, solved2 = false;
  if (!solved1) {
    r2 = await makeHints(word, 2, r1);
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
    guess1, guess2, solved1, solved2, nearMiss,
    outcome: solved1 ? 'round1' : solved2 ? 'round2' : 'fail',
  };
}

// ── 실행 ───────────────────────────────────────────────────────────────
const started = Date.now();
const results = [];
const used = new Set();

console.log(`제시어 풀 ${WORDS.length}개 · 라운드당 묘사 ${CFG.hints}개${CFG.dry ? ' · DRY' : ''}`);

for (let i = 1; i <= CFG.games; i++) {
  console.log(`\n━━ ${i}/${CFG.games} 판 ━━`);
  try {
    results.push(await playGame(i, used));
  } catch (e) {
    console.error(`  실패: ${e.message}`);
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
