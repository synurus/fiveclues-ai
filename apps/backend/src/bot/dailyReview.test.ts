import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySuggestions, reviewBody, reviewTitle, type ReviewItem } from './dailyReview';

test('classifySuggestions — 이미 인정되는 말은 빼고, 다른 제시어와 겹치면 표시', () => {
  const out = classifySuggestions('경찰관', ['경찰'], ['경찰', '순경', '고래', '순 경', '경찰관'], ['경찰관', '경찰', '고래', '돌고래']);
  assert.deepEqual(out, [
    { text: '순경', conflict: false },
    { text: '고래', conflict: true },
  ]);
});

test('reviewBody·reviewTitle — 표·체크리스트, 제목엔 정답 없음', () => {
  const item: ReviewItem = {
    lang: 'ko',
    date: '2026-10-01',
    number: 3,
    puzzle: { word: '냉면', category: '음식', promptVersion: 'v', model: 'm', round1: ['a'], round2: ['b'], banned: ['면'] },
    accept: [],
    suggestions: [
      { text: '물냉면', conflict: false },
      { text: '국수', conflict: true },
    ],
  };
  assert.equal(reviewTitle([item, { ...item, date: '2026-10-03' }]), '[오늘의 문제 검토] 2026-10-01 ~ 2026-10-03 (2문제)');
  const body = reviewBody([item]);
  assert.match(body, /\| 2026-10-01 \| #3 \| \*\*냉면\*\* \| 음식 \| \(없음\) \| 물냉면 · ~~국수~~ ⚠️다른 제시어 \|/);
  assert.match(body, /- \[ \] 2026-10-01 냉면 확인/);
  assert.match(body, /AI가 피한 특징: 면/);
});
