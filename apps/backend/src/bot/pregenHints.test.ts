import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRound, planNeeds, nextBatch, parseSets, ptDate, similarity, leaksPart, MAX_SETS_PER_WORD } from './pregenHints';
import type { HintSet, HintSetFile } from './hintSets';
import { cleanBanned } from './hintSource';

const h = (...texts: string[]) => texts.map((text) => ({ text, angle: 'a' }));

test('validateRound — 개수·길이·제시어 노출·다른 제시어·1라운드 중복', () => {
  const ok = h('하나', '둘', '셋', '넷', '다섯', '여섯');
  assert.deepEqual(validateRound(ok, '낚시', ['낚시']), ['하나', '둘', '셋', '넷', '다섯']);
  assert.equal(validateRound(h('하나', '둘', '셋', '넷'), '낚시', ['낚시']), null); // 4개뿐
  assert.equal(validateRound('묘사', '낚시', ['낚시']), null);
  // 제시어가 샌 것·같은 묶음의 다른 제시어가 들어간 것·너무 긴 것·1라운드와 같은 것은 빼고 센다
  const mixed = h('낚시터 의자', '김밥 옆에', 'x'.repeat(61), '이미 나옴', '하나', '둘', '셋', '넷');
  assert.equal(validateRound(mixed, '낚시', ['낚시', '김밥'], ['이미 나옴']), null);
  assert.deepEqual(validateRound([...mixed, ...h('다섯')], '낚시', ['낚시', '김밥'], ['이미 나옴']), ['하나', '둘', '셋', '넷', '다섯']);
});

test('planNeeds·nextBatch — 없는 단어 먼저, 한국어 먼저, 같은 카테고리끼리', () => {
  const set = (v: string, at: string): HintSet => ({ id: at, promptVersion: v, model: 'm', generatedAt: at, round1: [], round2: [] });
  const pools = {
    ko: [
      { word: '가', category: 'A' },
      { word: '나', category: 'A' },
      { word: '다', category: 'B' },
      { word: '라', category: 'A' },
    ],
    en: [{ word: 'x', category: 'A' }],
  };
  const files: Record<'ko' | 'en', HintSetFile> = {
    ko: { sets: { 가: [set('old', '2026-01-01')], 나: [set('cur', '2026-01-02')], 다: [] } },
    en: { sets: {} },
  };
  const needs = planNeeds(pools, files, { ko: 'cur', en: 'cur' });
  // 단계0(세트 없음): 다·라(한국어) → x(영어), 단계1(지금 세대 없음): 가, 단계2(개수 모자람): 나
  assert.deepEqual(
    needs.map((n) => `${n.word}${n.tier}`),
    ['다0', '라0', 'x0', '가1', '나2'],
  );
  assert.deepEqual(
    nextBatch(needs, 8).map((n) => n.word),
    ['다'], // 맨 앞 단어(다)의 카테고리 B·단계0만
  );
  assert.equal(MAX_SETS_PER_WORD, 2);
});

test('parseSets — 제시어 대소문자·띄어쓰기를 무시하고 찾는다', () => {
  const m = parseSets('{"sets":[{"word":"Hot Dog","hints":[1]},{"word":"김 밥","hints":[2]}]}');
  assert.deepEqual(m.get('hotdog')?.hints, [1]);
  assert.deepEqual(m.get('김밥')?.hints, [2]);
  assert.equal(parseSets('엉망').size, 0);
});

test('ptDate — 태평양 시간 날짜(한국 오후 4시 전후로 바뀜, 서머타임)', () => {
  assert.equal(ptDate(new Date('2026-09-28T06:59:00Z')), '2026-09-27'); // KST 15:59
  assert.equal(ptDate(new Date('2026-09-28T07:01:00Z')), '2026-09-28'); // KST 16:01
});

test('cleanBanned — 짧은 말만, 제시어 자체는 빼고, 최대 4개', () => {
  assert.deepEqual(cleanBanned(['면', '육수', '냉면', '면', 'x'.repeat(21), '', '겨자', '식초', '얼음'], '냉면'), ['면', '육수', '겨자', '식초']);
  assert.deepEqual(cleanBanned('면', '냉면'), []);
});

test('similarity·validateRound — 2라운드가 1라운드를 말만 바꿔 쓰면 버린다', () => {
  assert.ok(similarity('여러 층을 한입에 베어 무는 맛', '여러 층을 한꺼번에 베어 무는 맛') > 0.6);
  assert.ok(similarity('혀가 얼얼해지는 독특한 자극', '바삭함 뒤에 오는 부드러운 속살') < 0.1);
  const r1 = ['여러 층을 한입에 베어 무는 맛', '바쁜 시간에 간편히 먹는 한 끼', '손에 묻히지 않고 먹는 방식', '고기와 채소', '익숙함'];
  const reworded = h('여러 층을 한꺼번에 베어 무는 맛', '바쁜 시간에 간편히 채우는 끼니', '둥근 빵 사이에 끼운', '감자튀김과 짝꿍', '가게 앞 커다란 간판', '종이에 싸서 건네받는');
  assert.equal(validateRound(reworded, '햄버거', ['햄버거'], r1), null); // 새 정보는 4개뿐
  assert.deepEqual(validateRound([...reworded, ...h('한 손으로 쥐는 크기')], '햄버거', ['햄버거'], r1), [
    '둥근 빵 사이에 끼운', '감자튀김과 짝꿍', '가게 앞 커다란 간판', '종이에 싸서 건네받는', '한 손으로 쥐는 크기',
  ]);
});

test('leaksPart — 세 글자 이상 한국어 제시어의 앞쪽 절반이 들어간 묘사', () => {
  assert.equal(leaksPart('미군 부대 근처에서 유래된 이름', '부대찌개'), true);
  assert.equal(leaksPart('투명한 소스 속 목이버섯', '탕수육'), false);
  assert.equal(leaksPart('탕수 소스를 부어', '탕수육'), true);
  assert.equal(leaksPart('배가 고플 때', '배'), false); // 짧은 제시어는 안 봄
  assert.equal(leaksPart('A burger bun', 'hamburger'), false); // 영어는 안 봄
});
