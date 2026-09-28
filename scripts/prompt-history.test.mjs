// node --test "scripts/*.test.mjs" — 개선 기록 페이지 생성 로직(네트워크·git 없이).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGenerations, prReason, renderPage } from './prompt-history.mjs';

const c = (version, subject, iso = '2026-09-20T00:00:00Z') => ({ sha: version, at: new Date(iso), subject, version });

test('buildGenerations — 본문이 같은 커밋(주석만 수정)은 앞 세대에 묶고, 출처를 가른다', () => {
  const gens = buildGenerations([
    c('aaaa', 'feat: 처음'),
    c('aaaa', 'docs: 주석만 고침'),
    c('bbbb', 'Merge pull request #12 from x/self-improve/1'),
    c('cccc', '자가개선: 출제자 프롬프트 문구 조정 (피드백 4건)'),
    c(null, 'fix: 계산 못 한 버전'),
  ]);
  assert.deepEqual(
    gens.map((g) => [g.version, g.kind, g.pr, g.summary]),
    [
      ['aaaa', 'manual', null, '처음'],
      ['bbbb', 'auto', 12, ''],
      ['cccc', 'auto', null, '플레이어 피드백 4건을 읽고 문구를 다듬었습니다.'],
    ],
  );
});

test('prReason — PR 본문의 "모델이 밝힌 변경 이유" 인용만', () => {
  const body = '머리말\n\n### 모델이 밝힌 변경 이유\n> 첫 줄\n> 둘째 줄\n\n### 토큰\n...';
  assert.equal(prReason(body), '첫 줄 둘째 줄');
  assert.equal(prReason('이유 없음'), '');
});

test('renderPage — 쉬운 설명 우선, HTML 이스케이프, 최신 세대가 위', () => {
  const gens = buildGenerations([c('aaaa', 'feat: <b>옛</b>'), c('bbbb', 'feat: 새')]);
  const html = renderPage(gens, () => null, '2026년 9월 29일', { bbbb: '쉬운 설명' });
  assert.ok(html.indexOf('bbbb') < html.indexOf('aaaa'));
  assert.match(html, /<p>쉬운 설명<\/p>/);
  assert.match(html, /&lt;b&gt;옛&lt;\/b&gt;/);
  assert.match(html, /<!-- @header-ko -->/);
});
