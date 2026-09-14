#!/usr/bin/env node
// 관전 모드 프로토타입 — 봇만으로 라이어게임 한 판을 돌리고 지표를 뽑는다.
//
//   node scripts/spectate.mjs            한 판
//   GAMES=10 node scripts/spectate.mjs   열 판
//   DRY=1 node scripts/spectate.mjs      LLM 없이 배선만 확인
//
// 의존성 없음(Node 22+ 내장 fetch). DB도 안 쓴다 — 결과는 runs/ 에 JSONL로 떨어진다.
//
// 환경변수: BOT_BASE_URL, BOT_API_KEY, BOT_MODEL  (OpenAI 호환 엔드포인트)
//   Groq     https://api.groq.com/openai/v1
//   Cerebras https://api.cerebras.ai/v1
//   로컬     http://localhost:11434/v1   (Ollama)

import { writeFile, mkdir } from 'node:fs/promises';

const CFG = {
  baseUrl: process.env.BOT_BASE_URL ?? 'https://api.groq.com/openai/v1',
  apiKey: process.env.BOT_API_KEY ?? '',
  model: process.env.BOT_MODEL ?? 'llama-3.3-70b-versatile',
  bots: Number(process.env.BOTS ?? 5),
  games: Number(process.env.GAMES ?? 1),
  rounds: Number(process.env.ROUNDS ?? 2),
  dry: process.env.DRY === '1',
};

const WORDS = {
  동물: ['사자', '코끼리', '기린', '판다', '캥거루', '펭귄', '호랑이', '낙타'],
  음식: ['김치찌개', '짜장면', '피자', '초밥', '떡볶이', '삼겹살', '라면', '파스타'],
  과일: ['사과', '바나나', '딸기', '수박', '포도', '복숭아', '파인애플', '참외'],
  채소: ['당근', '양파', '감자', '오이', '브로콜리', '고구마', '마늘', '파'],
  직업: ['의사', '변호사', '소방관', '경찰관', '요리사', '선생님', '미용사', '개발자'],
  스포츠: ['축구', '야구', '농구', '배구', '수영', '골프', '테니스', '볼링'],
  탈것: ['자동차', '비행기', '기차', '자전거', '오토바이', '버스', '배', '헬리콥터'],
  가전제품: ['냉장고', '세탁기', '에어컨', '전자레인지', '청소기', '텔레비전', '정수기', '선풍기'],
  여행지: ['제주도', '파리', '도쿄', '뉴욕', '하와이', '방콕', '런던', '부산'],
  학용품: ['연필', '지우개', '볼펜', '필통', '노트', '가위', '풀', '자'],
  악기: ['피아노', '기타', '드럼', '바이올린', '트럼펫', '플루트', '첼로', '하모니카'],
  취미: ['독서', '등산', '낚시', '게임', '요리', '그림그리기', '사진찍기', '캠핑'],
};

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((p) => p[1]);

// ── LLM ────────────────────────────────────────────────────────────────
let calls = 0;

async function llm(system, user, { json = false } = {}) {
  calls++;
  if (CFG.dry) return json ? `{"vote":"A","leak":"A-1","guess":"사자","reason":"dry"}` : `[DRY] 발언 ${calls}`;

  const res = await fetch(`${CFG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${CFG.apiKey}` },
    body: JSON.stringify({
      model: CFG.model,
      temperature: 0.9,
      max_tokens: 200,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// 모델이 JSON을 어기는 일이 잦다. 중괄호만 긁어내는 폴백을 둔다.
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
const RULES = `
규칙:
- 한 문장, 25자 이내. 설명·서론 없이 발언만 출력한다.
- 제시어 자체와 그 일부를 직접 말하지 않는다.
- 이미 나온 발언을 반복하거나 바꿔 말하지 않는다.
`.trim();

const citizenSystem = (label, category, word) => `
너는 라이어 게임 참가자 "${label}"다. 주제는 "${category}", 제시어는 "${word}"다.

너는 두 압력 사이에 있다:
- 너무 모호하면 제시어를 모르는 것처럼 보여 라이어로 의심받는다.
- 너무 구체적이면 라이어가 제시어를 알아맞힌다.

${RULES}`.trim();

const liarSystem = (label, category) => `
너는 라이어 게임의 라이어 "${label}"다. 주제가 "${category}"라는 것만 알고 제시어는 모른다.

목표: 제시어를 아는 것처럼 보이게 한다. 다른 참가자의 발언에서 단서를 얻되,
베껴 말하면 들킨다. 주제 안에서 두루 통하는 말을 골라라.

${RULES}`.trim();

const transcriptOf = (msgs) =>
  msgs.length ? msgs.map((m) => `${m.label}(${m.round}R): ${m.text}`).join('\n') : '(아직 없음)';

// ── 한 판 ──────────────────────────────────────────────────────────────
async function playGame(gameNo) {
  const category = pick(Object.keys(WORDS));
  const word = pick(WORDS[category]);
  const labels = Array.from({ length: CFG.bots }, (_, i) => String.fromCharCode(65 + i));
  const liar = pick(labels);

  const messages = [];

  for (let round = 1; round <= CFG.rounds; round++) {
    // 발언 순서는 매 라운드 섞는다. 라이어가 첫 순서면 참고할 발언이 없어 불리하다 —
    // 그 불리함이 실제로 적발률에 나타나는지 보려고 순서를 기록해둔다.
    for (const label of shuffle(labels)) {
      const system = label === liar ? liarSystem(label, category) : citizenSystem(label, category, word);
      const text = await llm(
        system,
        `지금까지 나온 발언:\n${transcriptOf(messages)}\n\n${round}라운드, 네 차례다. 발언하라.`,
      );
      messages.push({ label, round, text: text.replace(/^["']|["']$/g, '') });
      process.stdout.write(`  ${label}(${round}R) ${text}\n`);
    }
  }

  // 봇 투표 — 자기 자신은 후보에서 뺀다
  const liarVotes = {};
  const leakVotes = {};
  for (const voter of labels) {
    const others = shuffle(labels.filter((l) => l !== voter));
    const raw = await llm(
      `너는 라이어 게임 참가자 "${voter}"다. 아래 발언들을 보고 판단하라.`,
      `발언 기록:\n${transcriptOf(messages)}\n\n` +
        `1) 라이어는 누구인가? 후보: ${others.join(', ')}\n` +
        `2) 제시어를 가장 많이 노출시킨 발언은 무엇인가? "라벨-라운드" 형식으로.\n\n` +
        `JSON만 출력: {"vote":"라벨","leak":"라벨-라운드","reason":"20자 이내"}`,
      { json: true },
    );
    const v = parseJson(raw, {});
    if (others.includes(v.vote)) liarVotes[v.vote] = (liarVotes[v.vote] ?? 0) + 1;
    if (typeof v.leak === 'string') leakVotes[v.leak] = (leakVotes[v.leak] ?? 0) + 1;
  }

  // 자동 추측자 — 사람 대신 힌트만 보고 제시어를 맞혀본다 (제시어 방어율용)
  const guessRaw = await llm(
    '너는 라이어 게임의 라이어다. 아래 발언만 보고 제시어를 맞혀라.',
    `주제: ${category}\n발언:\n${transcriptOf(messages)}\n\nJSON만 출력: {"guess":"단어"}`,
    { json: true },
  );
  const guess = parseJson(guessRaw, {}).guess ?? '';

  const topLiar = Object.entries(liarVotes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const topLeak = Object.entries(leakVotes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const result = {
    gameNo,
    category,
    word,
    liar,
    liarFirstRound1: messages[0]?.label === liar,
    messages,
    liarVotes,
    leakVotes,
    caught: topLiar === liar,
    topLiar,
    topLeak,
    guess,
    guessed: guess === word,
  };

  console.log(
    `\n  제시어 ${category}/${word} · 라이어 ${liar}` +
      `\n  봇 지목 ${topLiar ?? '-'} → ${result.caught ? '적발 성공' : '적발 실패'}` +
      `\n  최대 누출 ${topLeak ?? '-'}` +
      `\n  자동 추측 "${guess}" → ${result.guessed ? '뚫림' : '방어'}\n`,
  );
  return result;
}

// ── 실행 ───────────────────────────────────────────────────────────────
const started = Date.now();
const results = [];

for (let i = 1; i <= CFG.games; i++) {
  console.log(`\n━━ ${i}/${CFG.games} 판 ━━`);
  try {
    results.push(await playGame(i));
  } catch (e) {
    console.error(`  실패: ${e.message}`);
  }
}

const done = results.length;
if (done) {
  const caught = results.filter((r) => r.caught).length;
  const guessed = results.filter((r) => r.guessed).length;
  const leakBy = {};
  for (const r of results) {
    const label = r.topLeak?.split('-')[0];
    if (label) leakBy[label] = (leakBy[label] ?? 0) + 1;
  }
  console.log('━'.repeat(40));
  console.log(`판 수            ${done}`);
  console.log(`라이어 적발률    ${((caught / done) * 100).toFixed(0)}%  (${caught}/${done})`);
  console.log(`제시어 방어율    ${(((done - guessed) / done) * 100).toFixed(0)}%  (${done - guessed}/${done})`);
  console.log(`최대 누출 분포   ${JSON.stringify(leakBy)}`);
  console.log(`LLM 호출 ${calls}회 · ${((Date.now() - started) / 1000).toFixed(0)}초`);
  console.log('\n⚠️ 판이 적으면 이 숫자들은 운과 구분되지 않는다. 세대 비교는 최소 10판부터.');

  await mkdir('runs', { recursive: true });
  const path = `runs/${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  await writeFile(path, results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\n기록: ${path}`);
}
