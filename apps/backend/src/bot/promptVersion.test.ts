import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROMPT_VERSION } from './promptVersion';

// src 바깥의 .mjs라 경로를 문자열로 만들어 불러온다(정적 경로면 tsc가 rootDir·타입 선언을 따진다).
type Metrics = { promptVersionOf: (src: string) => string };
const loadMetrics = async (): Promise<Metrics> =>
  (await import(pathToFileURL(path.resolve(__dirname, '../../../../scripts/metrics.mjs')).href)) as Metrics;

// scripts/metrics.mjs는 옛 이슈에 세대를 소급할 때 과거 버전 파일에 같은 계산을 한다 —
// 두 계산이 어긋나면 새 이슈(런타임 값)와 옛 이슈(소급 값)가 다른 세대로 갈라진다.
test('런타임 세대 값이 scripts/metrics.mjs의 계산과 같다', async () => {
  const metrics = await loadMetrics();
  for (const [lang, file] of [
    ['ko', 'hintPrompt.ts'],
    ['en', 'hintPromptEn.ts'],
  ] as const) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.equal(metrics.promptVersionOf(src), PROMPT_VERSION[lang]);
  }
  assert.match(PROMPT_VERSION.ko, /^[0-9a-f]{8}$/);
});

test('주석만 바꾸면 세대가 같고, 본문을 바꾸면 달라진다', async () => {
  const metrics = await loadMetrics();
  const src = fs.readFileSync(path.join(__dirname, 'hintPrompt.ts'), 'utf8');
  assert.equal(metrics.promptVersionOf(src.replace('/**', '/**\n * 주석 한 줄 추가')), PROMPT_VERSION.ko);
  assert.notEqual(metrics.promptVersionOf(src.replace('각 묘사는 30자 이내.', '각 묘사는 25자 이내.')), PROMPT_VERSION.ko);
});
