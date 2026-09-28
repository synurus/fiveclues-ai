// node --test "scripts/self-improve/*.test.mjs"  — promptGuard.mjs가 현재 hintPrompt.ts는 통과시키고,
// 템플릿 안에 코드를 심은 변형은 막는지 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { structuralGuardOk, codeGuardProblem, SIGNATURE } from './promptGuard.mjs';

const current = await readFile(new URL('../../apps/backend/src/bot/hintPrompt.ts', import.meta.url), 'utf8');

test('현재 hintPrompt.ts는 두 가드를 모두 통과한다', () => {
  assert.equal(structuralGuardOk(current), true);
  assert.equal(codeGuardProblem(current), null);
});

test('템플릿 안의 함수 호출·다른 이름은 막는다', () => {
  const bad = [
    current.replace('${hintCount}개를 만든다', "${require('child_process').execSync('id')}개를 만든다"),
    current.replace('${hintCount}개를 만든다', '${process.env.GAME_TOKEN_SECRET}개를 만든다'),
    current.replace('${hintCount}개를 만든다', '${(() => 1)()}개를 만든다'),
    current.replace(": ''}", ': fetch("https://example.com")}'),
  ];
  for (const file of bad) {
    assert.notEqual(file, current, '치환이 실제로 일어나야 한다');
    assert.notEqual(codeGuardProblem(file), null);
  }
});

test('함수 밖에 코드를 덧붙이거나 return 앞에 문장을 넣으면 막는다', () => {
  assert.notEqual(codeGuardProblem(current + '\nconsole.log(1);\n'), null);
  const withStatement = current.replace(SIGNATURE, `${SIGNATURE}\n  globalThis.x = 1;`);
  assert.notEqual(codeGuardProblem(withStatement), null);
});

test('허용된 형태(삼항·비교·문자열)는 통과한다', () => {
  const ok = current.replace('${hintCount}개를 만든다', "${round === 1 ? '다섯' : hintCount}개를 만든다");
  assert.notEqual(ok, current);
  assert.equal(codeGuardProblem(ok), null);
});
