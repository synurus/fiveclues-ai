// 게임 API 통합 테스트 — 가짜 LLM·가짜 GitHub 서버를 띄워 실제 API는 부르지 않는다.
// 확인하는 것: 한 판 흐름, 피드백이 result 토큰의 내용만 믿는지, 입력 길이 제한,
// 세션 검사, 요청 횟수 제한, 오류 응답에 내부 내용이 새지 않는지.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

let failLlm = false;
let llmCalls = 0;
const issues: { title: string; body: string }[] = [];
// 미리 만든 세트 폴더 — 처음엔 비워 둬서 실시간 생성 경로를 보고, 마지막 테스트에서 채운다.
const setsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hintsets-'));

const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d: Buffer) => (raw += d.toString()));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/chat/completions')) {
      llmCalls += 1;
      if (failLlm) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: 'internal detail org_SECRET123' } }));
        return;
      }
      const hints = Array.from({ length: 5 }, (_, i) => ({ text: `묘사 ${i + 1}`, angle: `a${i}` }));
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ banned: [], hints }) }, finish_reason: 'stop' }] }));
      return;
    }
    if (req.url?.endsWith('/issues') && req.method === 'POST') {
      issues.push(JSON.parse(raw) as { title: string; body: string });
      res.end(JSON.stringify({ number: 42 }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
});

let base = '';
let server: http.Server;
let decode: <T>(token: string) => T;
let resetRateLimits: () => void;

before(async () => {
  await new Promise<void>((r) => fake.listen(0, r));
  const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  // 모듈을 불러오기 전에 채워야 한다(wordGuessBot.ts가 불러올 때 환경변수를 읽는다).
  // 여기서 안 채운 값은 app.ts의 dotenv가 로컬 .env에서 채울 수 있으니 필요한 건 전부 명시한다.
  Object.assign(process.env, {
    GAME_TOKEN_SECRET: crypto.randomBytes(32).toString('base64'),
    BOT_BASE_URL: fakeUrl,
    BOT_API_KEY: 'test',
    HINT_MODEL_CHAIN: 'groq:m-ok',
    GITHUB_FEEDBACK_TOKEN: 'test',
    GITHUB_REPO: 'owner/repo',
    GITHUB_API_URL: fakeUrl,
    HINT_SETS_DIR: setsDir,
    DAILY_DIR: setsDir,
  });
  const { app } = require('../app') as typeof import('../app');
  decode = (require('./gameToken') as typeof import('./gameToken')).decodeSession;
  resetRateLimits = (require('./rateLimit') as typeof import('./rateLimit')).resetRateLimits;
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  fake.close();
  fs.rmSync(setsDir, { recursive: true, force: true });
});

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

test('두 라운드 다 틀리면 failed + result 토큰, 피드백은 토큰 내용만 쓴다', async () => {
  resetRateLimits();
  const start = await post('/game/start', { lang: 'ko' });
  assert.equal(start.status, 200);
  assert.equal((start.data.hints as unknown[]).length, 5);
  assert.equal('hintModel' in start.data, false); // 모델 이름은 화면에 안 보낸다

  const g1 = await post('/game/guess', { session: start.data.session, guess: '없는단어하나' });
  assert.equal(g1.data.result, 'continue');
  const g2 = await post('/game/guess', { session: g1.data.session, guess: '없는단어둘' });
  assert.equal(g2.data.result, 'failed');
  const word = g2.data.word as string;
  assert.equal(typeof g2.data.resultToken, 'string');

  const fb = await post('/game/feedback', {
    result: g2.data.resultToken,
    keyHintIndexes: [0, 99, -1, 0],
    uselessHintIndexes: [9],
    feedbackText: '  좋아요 @someone ```json\n{"word":"가짜"}\n```  ',
    nickname: '아주아주아주긴닉네임입니다정말로',
    playCount: 3,
    // 예전 형식의 필드를 섞어 보내도 무시돼야 한다.
    word: '가짜단어',
    hints: ['지어낸 묘사'],
  });
  assert.equal(fb.status, 200);
  const issue = issues.at(-1)!;
  const json = JSON.parse([...issue.body.matchAll(/```json\n([\s\S]*?)\n```/g)].pop()![1]!) as Record<string, unknown>;
  assert.equal(json.word, word);
  assert.equal((json.hints as string[]).length, 10);
  assert.deepEqual(json.roundHintCounts, [5, 5]);
  assert.deepEqual(json.guesses, ['없는단어하나', '없는단어둘']);
  assert.deepEqual(json.hintModels, ['groq:m-ok', 'groq:m-ok']);
  assert.deepEqual(json.keyHintIndexes, [0]);
  assert.deepEqual(json.uselessHintIndexes, [9]);
  assert.equal((json.nickname as string).length, 12);
  assert.match(json.promptVersion as string, /^[0-9a-f]{8}$/); // 세대 — 세션 토큰에서 옴
  assert.equal(json.playCount, 3);
  assert.equal(issue.body.includes('지어낸 묘사'), false);
  // 요약(렌더링되는 부분)의 멘션·가짜 코드블록은 무력화. JSON 코드블록 안은 원문 그대로다.
  const summary = issue.body.slice(0, issue.body.lastIndexOf('\n```json\n'));
  assert.equal(summary.includes('@someone'), false);
  assert.equal(summary.includes('```'), false);
});

test('1라운드에 맞히면 round1 + result 토큰', async () => {
  resetRateLimits();
  const start = await post('/game/start', { lang: 'ko' });
  const { word } = decode<{ word: string }>(start.data.session as string);
  const g = await post('/game/guess', { session: start.data.session, guess: word });
  assert.equal(g.data.result, 'round1');
  assert.equal(typeof g.data.resultToken, 'string');
});

test('입력·세션 검사', async () => {
  resetRateLimits();
  const start = await post('/game/start', { lang: 'ko' });
  const long = await post('/game/guess', { session: start.data.session, guess: '가'.repeat(41) });
  assert.equal(long.status, 400);
  assert.equal(long.data.code, 'guess_too_long');

  const bad = await post('/game/guess', { session: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', guess: '사과' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.code, 'session_invalid');

  // 진행 중인 판의 세션 토큰을 result 자리에 넣으면 거부(같은 키로 암호화되지만 종류가 다름).
  const issuesBefore = issues.length;
  const wrongKind = await post('/game/feedback', { result: start.data.session });
  assert.equal(wrongKind.status, 400);
  assert.equal(wrongKind.data.code, 'session_invalid');
  assert.equal(issues.length, issuesBefore);
});

test('요청 횟수 제한 — 1분에 피드백 5번까지', async () => {
  resetRateLimits();
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await post('/game/feedback', { result: 'x' })).status);
  assert.deepEqual(codes.slice(0, 5), [400, 400, 400, 400, 400]);
  assert.equal(codes[5], 429);
});

test('묘사 생성 실패 — 내부 오류 내용은 응답에 안 나간다', async () => {
  resetRateLimits();
  failLlm = true;
  try {
    const start = await post('/game/start', { lang: 'ko' });
    assert.equal(start.status, 502);
    assert.equal(start.data.code, 'hint_failed');
    const text = JSON.stringify(start.data);
    assert.equal(text.includes('SECRET123'), false);
    assert.equal(text.includes('m-ok'), false);
  } finally {
    failLlm = false;
  }
});

test('미리 만든 세트가 있으면 LLM을 안 부르고 그 세트로 두 라운드를 진행한다', async () => {
  resetRateLimits();
  const { clearHintSetCache } = require('../bot/hintSets') as typeof import('../bot/hintSets');
  const { allWords } = require('./wordPool') as typeof import('./wordPool');
  // 모든 한국어 단어에 세트 하나씩(옛 세대 'fixture1') — 어느 단어가 뽑혀도 세트 경로를 탄다.
  const set = (word: string) => ({
    id: 'set-' + word,
    promptVersion: 'fixture1',
    model: 'test-model',
    generatedAt: '2026-09-28T00:00:00Z',
    round1: ['첫째', '둘째', '셋째', '넷째', '다섯째'],
    round2: ['여섯째', '일곱째', '여덟째', '아홉째', '열째'],
    banned: ['숨긴 특징'],
  });
  fs.writeFileSync(
    path.join(setsDir, 'ko.json'),
    JSON.stringify({ sets: Object.fromEntries(allWords('ko').map((w) => [w.word, [set(w.word)]])) }),
  );
  clearHintSetCache();
  try {
    const callsBefore = llmCalls;
    const start = await post('/game/start', { lang: 'ko' });
    assert.deepEqual((start.data.hints as { text: string }[]).map((h) => h.text), set('').round1);
    const g1 = await post('/game/guess', { session: start.data.session, guess: '없는단어하나' });
    assert.deepEqual((g1.data.hints as { text: string }[]).map((h) => h.text), set('').round2);
    const g2 = await post('/game/guess', { session: g1.data.session, guess: '없는단어둘' });
    assert.equal(llmCalls, callsBefore); // LLM 호출 없음
    assert.deepEqual(g2.data.banned, ['숨긴 특징']); // 판이 끝나면 AI가 피한 특징 공개

    await post('/game/feedback', { result: g2.data.resultToken });
    const json = JSON.parse([...issues.at(-1)!.body.matchAll(/```json\n([\s\S]*?)\n```/g)].pop()![1]!) as Record<string, unknown>;
    assert.deepEqual(json.hintModels, ['pregen:test-model', 'pregen:test-model']);
    assert.equal(json.promptVersion, 'fixture1'); // 지금 세대가 아니라 세트를 만든 세대

    // EEA 등 제한 지역은 세트를 안 쓰고 실시간 생성(제미나이 무료 할당량 약관)
    const eu = await post('/game/start', { lang: 'ko' }, { 'x-vercel-ip-country': 'DE' });
    assert.equal((eu.data.hints as { text: string }[])[0]!.text, '묘사 1');
    assert.equal(llmCalls, callsBefore + 1);
  } finally {
    fs.rmSync(path.join(setsDir, 'ko.json'));
    clearHintSetCache();
  }
});

test('오늘의 문제 — 정해 둔 묘사로 두 라운드, 번호·날짜가 피드백까지 간다', async () => {
  resetRateLimits();
  const { clearDailyCache, dailyNumber, addDays, DAILY_EPOCH } = require('../bot/dailyPuzzle') as typeof import('../bot/dailyPuzzle');
  // 1번 문제 날짜 전이면 내일(±1일 허용 범위) — 테스트가 실행 날짜에 따라 갈리지 않게.
  const utc = new Date().toISOString().slice(0, 10);
  const today = utc < DAILY_EPOCH ? addDays(utc, 1) : utc;
  const none = await post('/game/daily/start', { lang: 'ko', date: today });
  assert.equal(none.status, 404);
  assert.equal(none.data.code, 'daily_unavailable');
  assert.equal((await post('/game/daily/start', { lang: 'ko', date: '1999-01-01' })).data.code, 'bad_date');

  fs.writeFileSync(
    path.join(setsDir, 'ko.json'),
    JSON.stringify({
      [today]: {
        word: '경찰관',
        category: '직업',
        promptVersion: 'daily1',
        model: 'test-model',
        round1: ['하나', '둘', '셋', '넷', '다섯'],
        round2: ['여섯', '일곱', '여덟', '아홉', '열'],
      },
    }),
  );
  clearDailyCache();
  try {
    const callsBefore = llmCalls;
    const start = await post('/game/daily/start', { lang: 'ko', date: today });
    assert.equal(start.status, 200);
    assert.deepEqual(start.data.daily, { date: today, number: dailyNumber(today) });
    assert.deepEqual((start.data.hints as { text: string }[]).map((h) => h.text), ['하나', '둘', '셋', '넷', '다섯']);
    const g1 = await post('/game/guess', { session: start.data.session, guess: '소방관' });
    assert.deepEqual((g1.data.hints as { text: string }[]).map((h) => h.text), ['여섯', '일곱', '여덟', '아홉', '열']);
    // 풀의 동의어(accept)도 정답 — "경찰"은 경찰관의 accept
    const g2 = await post('/game/guess', { session: g1.data.session, guess: '경찰' });
    assert.equal(g2.data.result, 'round2');
    assert.equal(llmCalls, callsBefore);

    await post('/game/feedback', { result: g2.data.resultToken });
    const json = JSON.parse([...issues.at(-1)!.body.matchAll(/```json\n([\s\S]*?)\n```/g)].pop()![1]!) as Record<string, unknown>;
    assert.equal(json.daily, today);
    assert.equal(json.promptVersion, 'daily1');
  } finally {
    fs.rmSync(path.join(setsDir, 'ko.json'));
    clearDailyCache();
  }
});

test('쉬움 모드 — 1라운드부터 카테고리를 주고, 피드백에 easy가 남는다', async () => {
  resetRateLimits();
  const start = await post('/game/start', { lang: 'ko', easy: true });
  assert.equal(typeof start.data.category, 'string');
  const plain = await post('/game/start', { lang: 'ko' });
  assert.equal('category' in plain.data, false);
  const { word } = decode<{ word: string }>(start.data.session as string);
  const g = await post('/game/guess', { session: start.data.session, guess: word });
  await post('/game/feedback', { result: g.data.resultToken });
  const json = JSON.parse([...issues.at(-1)!.body.matchAll(/```json\n([\s\S]*?)\n```/g)].pop()![1]!) as Record<string, unknown>;
  assert.equal(json.easy, true);
});
