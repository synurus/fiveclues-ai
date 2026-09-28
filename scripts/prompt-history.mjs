#!/usr/bin/env node
// "AI 출제자 개선 기록" 페이지(apps/frontend/guides/prompt-history.html)를 만든다(2026-09-29).
// 플레이어가 남긴 👍·👎가 실제로 무엇을 바꿨는지 보여 줘서 피드백을 남길 이유를 주려는 것
// (기획서 v3 — 라벨링 피로 대책). .github/workflows/prompt-history.yml이 매일, 그리고
// hintPrompt.ts가 바뀔 때 돌려 커밋한다.
//
//   node scripts/prompt-history.mjs            페이지를 다시 쓴다(GH_TOKEN 있으면 사용)
//
// 세대 = 게임에 들어가는 프롬프트 본문의 해시(metrics.mjs의 promptVersionOf) — 주석만 바꾼
// 커밋은 앞 세대에 묶여 목록에 안 나온다. 무엇을 왜 바꿨는지는:
//   - 자동 개선 PR 머지("Merge pull request #N") → 그 PR 본문의 "모델이 밝힌 변경 이유"
//   - 초기의 "자가개선: ..." 커밋 → 자동 개선 제안이라는 것만(당시 PR 정보가 없다)
//   - 그 밖 → 운영자 직접 수정, 커밋 제목

import { execSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { PROMPT_FILES, promptVersionOf, fetchFeedbackIssues, aggregate, promptTimeline, wilson } from './metrics.mjs';

const OUT = 'apps/frontend/guides/prompt-history.html';
// 세대별 쉬운 설명 — 운영자가 직접 고친 세대는 커밋 제목이 개발 용어라 여기서 풀어 쓴다.
const NOTES = 'scripts/prompt-history-notes.json';

function repoName() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const m = execSync('git remote get-url origin', { encoding: 'utf8' }).trim().match(/github\.com[:/](.+?)(\.git)?$/);
    if (m) return m[1];
  } catch {
    /* 기본값 */
  }
  return 'synurus/fiveclues-ai';
}

/** main 1차 부모 이력에서 프롬프트 파일을 바꾼 커밋들(오래된 순). */
export function promptCommits(file = PROMPT_FILES.ko) {
  const log = execSync(`git log --first-parent --format=%H%x09%cI%x09%s HEAD -- ${file}`, { encoding: 'utf8' }).trim();
  if (!log) return [];
  return log
    .split('\n')
    .map((line) => {
      const [sha, iso, ...rest] = line.split('\t');
      let version = null;
      try {
        version = promptVersionOf(execSync(`git show ${sha}:${file}`, { encoding: 'utf8' }));
      } catch {
        /* 그 시점 파일 형태가 달라 계산 못 함 — 목록에서 뺀다 */
      }
      return { sha, at: new Date(iso), subject: rest.join('\t'), version };
    })
    .reverse();
}

// 커밋 제목 → 설명. 초기 "자가개선: ... (피드백 N건)" 커밋은 이유가 안 남아 있어 건수만 쓴다.
function subjectSummary(subject) {
  if (/^자가개선:/.test(subject)) {
    const n = subject.match(/피드백 (\d+)건/)?.[1];
    return `플레이어 피드백${n ? ` ${n}건` : ''}을 읽고 문구를 다듬었습니다.`;
  }
  return subject.replace(/^(feat|fix|refactor|chore|docs)(\([^)]*\))?:\s*/, '').replace(/^hintPrompt:\s*/, '');
}

/** 커밋들 → 세대 목록(본문이 실제로 바뀐 커밋만). */
export function buildGenerations(commits) {
  const gens = [];
  for (const c of commits) {
    if (!c.version || gens.at(-1)?.version === c.version) continue;
    const pr = c.subject.match(/^Merge pull request #(\d+)/);
    gens.push({
      version: c.version,
      at: c.at,
      kind: pr || /^자가개선:/.test(c.subject) ? 'auto' : 'manual',
      pr: pr ? Number(pr[1]) : null,
      summary: pr ? '' : subjectSummary(c.subject),
    });
  }
  return gens;
}

/** 자동 개선 PR 본문에서 "모델이 밝힌 변경 이유" 인용문만 꺼낸다. */
export function prReason(body) {
  const m = (body ?? '').match(/### 모델이 밝힌 변경 이유\s*\n((?:>.*\n?)+)/);
  return m ? m[1].split('\n').map((l) => l.replace(/^>\s?/, '')).join(' ').replace(/\s+/g, ' ').trim() : '';
}

async function fillPrReasons(gens) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  for (const g of gens) {
    if (!g.pr) continue;
    try {
      const res = await fetch(`https://api.github.com/repos/${repoName()}/pulls/${g.pr}`, { headers });
      if (res.ok) g.summary = prReason((await res.json()).body);
    } catch {
      /* 이유 없이 둔다 */
    }
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const kstDate = (d) => {
  const k = new Date(d.getTime() + 9 * 3600_000);
  return `${k.getUTCFullYear()}년 ${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일`;
};

function statLine(label, s) {
  if (!s?.n) return '';
  const r1 = Math.round((s.round1 / s.n) * 100);
  const fin = Math.round(((s.round1 + s.round2) / s.n) * 100);
  const [lo, hi] = wilson(s.round1, s.n).map((x) => Math.round(x * 100));
  return `${label} ${s.n}판 — 1라운드 정답률 ${r1}%(${lo}~${hi}%), 최종 ${fin}%`;
}

function combine(...stats) {
  const out = { n: 0, round1: 0, round2: 0, failed: 0 };
  for (const s of stats) if (s) for (const k of Object.keys(out)) out[k] += s[k] ?? 0;
  return out;
}

export function renderPage(gens, bySourceOf, updated, notes = {}) {
  const items = [...gens]
    .reverse()
    .map((g) => {
      const src = bySourceOf(g.version);
      const human = statLine('사람', src?.get('사람'));
      const ai = statLine('AI 자동 플레이', combine(src?.get('AI(제미나이 추측)'), src?.get('AI(Groq 추측)')));
      const who =
        g.kind === 'auto'
          ? `피드백을 읽은 AI가 낸 수정안${g.pr ? ` <a href="https://github.com/${esc(repoName())}/pull/${g.pr}" rel="noopener" target="_blank">#${g.pr}</a>` : ''} — 운영자가 검토한 뒤 반영`
          : '운영자가 직접 수정';
      const stats = [human, ai].filter(Boolean);
      return [
        `        <h2>${kstDate(g.at)} · 세대 <code>${esc(g.version)}</code></h2>`,
        `        <p class="site-meta">${who}</p>`,
        `        <p>${esc(notes[g.version] || g.summary || '플레이어 피드백을 읽고 문구를 다듬었습니다.')}</p>`,
        stats.length
          ? `        <ul>\n${stats.map((l) => `          <li>${esc(l)}</li>`).join('\n')}\n        </ul>`
          : '        <p class="site-meta">이 세대로 남은 피드백은 아직 없습니다.</p>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI 출제자 개선 기록 — 여러분의 👍·👎가 바꾼 것들 | 다섯고개</title>
    <meta name="description" content="다섯고개 AI 출제자의 지시문이 언제, 무엇 때문에, 어떻게 바뀌어 왔는지와 바뀐 뒤의 정답률을 모아 둔 기록입니다." />
    <link rel="canonical" href="https://fiveclues-ai.vercel.app/guides/prompt-history" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="다섯고개" />
    <meta property="og:title" content="AI 출제자 개선 기록" />
    <meta property="og:url" content="https://fiveclues-ai.vercel.app/guides/prompt-history" />
    <!-- @head-common -->
  </head>
  <body>
    <!-- @header-ko -->

    <main class="site-main">
      <article class="site-article">
        <a class="site-back" href="/guides">← 읽을거리</a>
        <h1>AI 출제자 개선 기록</h1>
        <p class="site-byline">자동으로 갱신되는 기록 · 기준 ${esc(updated)}</p>
        <p class="site-lead">다섯고개의 묘사는 AI가 “지시문”을 읽고 만듭니다. 여러분이 결과 화면에서 누른 👍·👎와 남긴 한마디는 매일 한 번 모여, 피드백을 읽은 AI가 지시문 수정안을 냅니다. 운영자가 그 수정안을 읽어 보고 괜찮을 때만 반영합니다. 이 페이지는 지시문이 실제로 바뀐 때마다 무엇이 왜 바뀌었는지, 그리고 그 지시문으로 플레이한 판들의 성적을 모아 둔 기록입니다.</p>

        <h2>이 기록을 읽는 법</h2>
        <ul>
          <li><strong>세대</strong> — 지시문 내용이 바뀔 때마다 새 세대가 됩니다. 옆의 여덟 글자는 그 세대를 구분하는 이름표입니다.</li>
          <li><strong>1라운드 정답률</strong> — 묘사 다섯 개만 보고 맞힌 비율입니다. 너무 높으면 묘사가 쉽고, 너무 낮으면 막연하다는 뜻입니다. 목표는 25~35% 정도입니다. 괄호 안은 판 수가 적어서 생기는 오차 범위(95%)로, 범위가 겹치는 두 세대는 “나아졌다”고 말하기 어렵습니다.</li>
          <li><strong>사람 / AI 자동 플레이</strong> — AI가 하루 몇 판씩 직접 플레이해 남긴 기록도 함께 씁니다. AI는 사람보다 훨씬 잘 맞히기 때문에 숫자를 사람과 직접 비교하지 말고, 세대끼리의 변화만 보세요.</li>
          <li>피드백을 보낸 판만 기록됩니다. 쉬움 모드로 푼 판은 조건이 달라 빼고 셉니다.</li>
        </ul>

${items}

        <h2>피드백을 남기려면</h2>
        <p>게임이 끝난 뒤 결과 화면에서 정답을 떠올리게 한 묘사에 👍, 전혀 도움이 안 된 묘사에 👎를 누르고 <em>피드백 보내기</em>를 누르면 됩니다. 한마디를 적어 주시면 수정안을 만드는 AI가 그대로 읽습니다. 피드백은 <a href="https://github.com/${esc(repoName())}/issues" rel="noopener" target="_blank">공개 저장소</a>에 기록되니 개인 정보는 적지 말아 주세요.</p>
      </article>
    </main>

    <!-- @footer-ko -->
  </body>
</html>
`;
}

async function main() {
  const gens = buildGenerations(promptCommits());
  await fillPrReasons(gens);
  let bySourceOf = () => null;
  let updated = '-';
  try {
    const items = await fetchFeedbackIssues();
    const { ordered } = aggregate(items, promptTimeline('ko'), 'ko');
    const map = new Map(ordered);
    bySourceOf = (v) => map.get(v)?.bySource ?? null;
    const last = items.reduce((m, x) => (x.createdAt > m ? x.createdAt : m), new Date(0));
    if (last.getTime()) updated = kstDate(last);
  } catch (e) {
    console.error('성적 집계 실패 — 성적 없이 쓴다:', e instanceof Error ? e.message : e);
  }
  const notes = JSON.parse(await readFile(NOTES, 'utf8').catch(() => '{}'));
  const html = renderPage(gens, bySourceOf, updated, notes);
  const before = await readFile(OUT, 'utf8').catch(() => '');
  if (before === html) {
    console.log('바뀐 것 없음');
    return;
  }
  await writeFile(OUT, html);
  console.log(`${OUT} — 세대 ${gens.length}개`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
