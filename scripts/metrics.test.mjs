// node --test "scripts/*.test.mjs" — metrics.mjs 집계 로직(네트워크·git 없이).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, formatReport, wilson, sourceOf, parseFeedback } from './metrics.mjs';

const at = (s) => new Date(s);
const timeline = [
  { sha: 'a', at: at('2026-09-20T00:00:00Z'), version: 'aaaaaaaa' },
  { sha: 'b', at: at('2026-09-25T00:00:00Z'), version: 'bbbbbbbb' },
  { sha: 'c', at: at('2026-09-26T00:00:00Z'), version: 'bbbbbbbb' }, // 주석만 바뀐 커밋 — 같은 세대
];
const game = (outcome, extra = {}) => ({
  word: 'w',
  category: '동물',
  outcome,
  hints: Array(outcome === 'round1' ? 5 : 10).fill('h'),
  uselessHintIndexes: [0],
  nickname: '사람',
  ...extra,
});

test('세대 소급: 기록된 값이 우선, 없으면 이슈 시각에 main에 있던 버전', () => {
  const items = [
    { createdAt: at('2026-09-19T00:00:00Z'), data: game('failed') }, // 추적 전
    { createdAt: at('2026-09-21T00:00:00Z'), data: game('round1') },
    { createdAt: at('2026-09-27T00:00:00Z'), data: game('round2') }, // 세 번째 커밋 뒤 → bbbbbbbb
    { createdAt: at('2026-09-21T00:00:00Z'), data: game('round1', { promptVersion: 'bbbbbbbb' }) },
    { createdAt: at('2026-09-27T00:00:00Z'), data: game('round1', { lang: 'en' }) }, // 다른 언어는 제외
  ];
  const { ordered } = aggregate(items, timeline, 'ko');
  const n = Object.fromEntries(ordered.map(([v, g]) => [v, g.bySource.get('사람').n]));
  assert.deepEqual(n, { '(추적 전)': 1, aaaaaaaa: 1, bbbbbbbb: 2 });
});

test('출처 구분·처음 3판 분리·표 출력', () => {
  assert.equal(sourceOf({ nickname: 'AI자동플레이', guesserModel: 'gemini-3.8-flash' }), 'AI(제미나이 추측)');
  assert.equal(sourceOf({ nickname: 'AI자동플레이', guesserModel: 'openai/gpt-oss-120b' }), 'AI(Groq 추측)');
  assert.equal(sourceOf({ nickname: '흑기사' }), '사람');
  const items = [
    { createdAt: at('2026-09-21T00:00:00Z'), data: game('round1', { playCount: 1 }) },
    { createdAt: at('2026-09-21T00:00:00Z'), data: game('failed', { playCount: 9 }) },
  ];
  const agg = aggregate(items, timeline, 'ko');
  assert.equal(agg.humanEarly.get('aaaaaaaa').n, 1);
  const report = formatReport(agg);
  assert.match(report, /\| aaaaaaaa \| 2 \| 50% \(/);
  assert.match(report, /처음 3판/);
});

test('윌슨 구간·마지막 json 블록', () => {
  const [lo, hi] = wilson(5, 10);
  assert.ok(lo > 0.2 && lo < 0.25 && hi > 0.75 && hi < 0.8);
  assert.deepEqual(wilson(0, 0), [0, 0]);
  const body = '> ```json\n{"word":"가짜"}\n```\n\n```json\n{"word":"진짜"}\n```';
  assert.equal(parseFeedback(body).word, '진짜');
});
