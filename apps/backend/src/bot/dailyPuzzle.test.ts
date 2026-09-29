import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acceptableDate,
  addDays,
  archiveDate,
  clearDailyCache,
  dailyNumber,
  dailyPath,
  listDaily,
  scheduleDaily,
  DAILY_EPOCH,
  type DailyFile,
} from './dailyPuzzle';
import type { HintSetFile } from './hintSets';

const set = (v: string, at = '2026-09-28T00:00:00Z') => ({
  id: v + at,
  promptVersion: v,
  model: 'm',
  generatedAt: at,
  round1: ['a', 'b', 'c', 'd', 'e'],
  round2: ['f', 'g', 'h', 'i', 'j'],
});

test('날짜 — 번호, ±1일만 허용', () => {
  assert.equal(dailyNumber(DAILY_EPOCH), 1);
  assert.equal(dailyNumber(addDays(DAILY_EPOCH, 9)), 10);
  const now = new Date('2026-10-05T12:00:00Z');
  assert.equal(acceptableDate('2026-10-04', now), '2026-10-04');
  assert.equal(acceptableDate('2026-10-06', now), '2026-10-06');
  assert.equal(acceptableDate('2026-10-07', now), null); // 모레는 안 됨
  assert.equal(acceptableDate('2026-13-01', now), null);
  assert.equal(acceptableDate(20261005, now), null);
});

test('scheduleDaily — 빈 날짜만 채우고, 최근 단어는 다시 안 고르고, 지금 세대를 먼저', () => {
  const sets: HintSetFile = { sets: { 가: [set('old')], 나: [set('cur')], 다: [set('cur')], 라: [] } };
  const file: DailyFile = {
    '2026-10-01': { word: '나', category: 'C', promptVersion: 'cur', model: 'm', round1: [], round2: [] },
  };
  const categoryOf = (w: string) => (w === '다' ? undefined : 'C'); // 다: 풀에서 빠진 단어
  const added = scheduleDaily(file, sets, categoryOf, 'cur', '2026-10-01', 3, () => 0);
  // 10-01은 이미 있음. 10-02: 나는 최근에 나왔고 다는 풀에 없음 → 가(옛 세대라도). 10-03: 남은 후보 없음 → 멈춤
  assert.deepEqual(added, ['2026-10-02']);
  assert.equal(file['2026-10-02']!.word, '가');
  assert.deepEqual(file['2026-10-02']!.round1, ['a', 'b', 'c', 'd', 'e']); // 묘사를 통째로 복사
  assert.equal(file['2026-10-01']!.word, '나'); // 이미 정한 날짜는 그대로
});

test('scheduleDaily — 1번 문제 이전 날짜는 채우지 않는다', () => {
  const file: DailyFile = {};
  const added = scheduleDaily(file, { sets: { 가: [set('cur')] } }, () => 'C', 'cur', addDays(DAILY_EPOCH, -2), 3, () => 0);
  assert.deepEqual(added, [DAILY_EPOCH]);
});

test('archiveDate·listDaily — 1번 문제부터 UTC 내일까지만, 목록엔 날짜·번호만', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  assert.equal(archiveDate('2026-09-29', now), '2026-09-29');
  assert.equal(archiveDate('2026-10-06', now), '2026-10-06');
  assert.equal(archiveDate('2026-10-07', now), null);
  assert.equal(archiveDate('2026-09-28', now), null); // 1번 문제 전
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-'));
  process.env.DAILY_DIR = dir;
  const p = { word: 'w', category: 'c', promptVersion: 'v', model: 'm', round1: [], round2: [] };
  fs.writeFileSync(dailyPath('ko'), JSON.stringify({ '2026-09-30': p, '2026-10-06': p, '2026-10-09': p }));
  clearDailyCache();
  try {
    assert.deepEqual(listDaily('ko', now), [
      { date: '2026-10-06', number: 8 },
      { date: '2026-09-30', number: 2 },
    ]);
  } finally {
    delete process.env.DAILY_DIR;
    clearDailyCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
