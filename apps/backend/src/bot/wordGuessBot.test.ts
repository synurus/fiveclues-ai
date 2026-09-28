// npm test -w backend — 정답 판정·제시어 노출 검사처럼 규칙이 많은 함수의 회귀 테스트.
// 판정 예시는 실제로 문제가 됐던 쌍들이다(wordGuessBot.ts의 judgeGuess 주석 참고).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeGuess, leaksWord } from './wordGuessBot';

test('judgeGuess — 정답·동의어·포함 관계', () => {
  assert.equal(judgeGuess('카메라', '카메라'), 'exact');
  assert.equal(judgeGuess('카메라', ' 카 메 라 '), 'exact');
  assert.equal(judgeGuess('경찰관', '경찰', ['경찰']), 'exact');
  assert.equal(judgeGuess('골프', '골프공', []), 'loose');
  assert.equal(judgeGuess('카메라', '디지털카메라', []), 'loose');
  assert.equal(judgeGuess('휴대폰', '핸드폰', ['핸드폰']), 'exact');
  assert.equal(judgeGuess('카메라', ''), 'wrong');
});

test('judgeGuess — 다른 제시어·한 글자 포함은 오답', () => {
  assert.equal(judgeGuess('돌고래', '고래'), 'wrong'); // "고래"는 풀의 다른 제시어
  assert.equal(judgeGuess('배드민턴', '배'), 'wrong'); // 한 글자 포함 + 다른 제시어
  assert.equal(judgeGuess('줄자', '자'), 'wrong'); // 한 글자 포함
});

test('judgeGuess — 영어는 단어 단위', () => {
  assert.equal(judgeGuess('elephant', 'ant'), 'wrong');
  assert.equal(judgeGuess('elephant', 'an'), 'wrong');
  assert.equal(judgeGuess('dolphin', 'Dolphins'), 'loose');
  assert.equal(judgeGuess('dolphin', 'a dolphin'), 'loose');
  assert.equal(judgeGuess('Tambourine', 'tambourine'), 'exact');
});

test('leaksWord — 제시어가 묘사에 그대로 들어갔는지', () => {
  assert.equal(leaksWord('낚시터에 놓인 작은 의자', '낚시'), true);
  assert.equal(leaksWord('물가에서 오래 기다림', '낚시'), false);
  assert.equal(leaksWord('배고플 때 생각남', '배'), false); // 한 글자 제시어는 검사 안 함
  assert.equal(leaksWord('You hold a fishing rod', 'fishing'), true);
  assert.equal(leaksWord('Loves fish', 'fishing'), false);
  assert.equal(leaksWord('Tiny but strong', 'ant'), false); // 철자 포함(want 등)은 아님
});
