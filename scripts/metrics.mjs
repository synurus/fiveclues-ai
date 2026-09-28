#!/usr/bin/env node
// 출제 프롬프트 세대별 성적표(2026-09-28, 기획서 v2 §6·§8). 'feedback' 라벨 이슈(열림·닫힘
// 전부)를 모아 세대 × 출처(사람 / AI 추측자)별로 1라운드·최종 정답률, 무쓸모율을 낸다.
//
//   node scripts/metrics.mjs                 한국어, 표준 출력
//   node scripts/metrics.mjs --lang en       영어
//   node scripts/metrics.mjs --out m.md      파일로도 저장
//   (GH_TOKEN이 있으면 쓴다 — 없어도 공개 레포라 읽힌다. 시간당 60회 제한)
//
// 세대 = 게임에 실제로 들어가는 프롬프트 본문의 해시(apps/backend/src/bot/promptVersion.ts와
// 같은 계산). 이 값이 이슈에 기록되기 전(2026-09-28 이전)의 이슈는, git 이력에서
// hintPrompt.ts의 과거 버전을 꺼내 같은 해시를 계산한 뒤 "그 이슈가 만들어진 시각에 main에
// 있던 버전"으로 소급해 붙인다. 주석만 고친 커밋은 해시가 같아 한 세대로 묶인다.
//
// 읽을 때 주의:
//  - 피드백을 보낸 판만 기록된다 — 사람 판은 "피드백을 남긴 판"의 성적이다(선택 편향).
//  - AI 추측자는 사람보다 문맥 추론이 강해 절대 수치가 높다 — 세대끼리의 변화만 볼 것.
//  - 표본이 작으면 괄호 안 95% 신뢰구간이 넓다. 구간이 겹치면 "나아졌다"고 말할 수 없다.

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import vm from 'node:vm';

const require = createRequire(import.meta.url);

export const PROMPT_FILES = {
  ko: 'apps/backend/src/bot/hintPrompt.ts',
  en: 'apps/backend/src/bot/hintPromptEn.ts',
};
const AI_NICKNAME = 'AI자동플레이'; // apps/backend/src/bot/autoPlay.ts의 NICKNAME
const BEFORE = '(추적 전)';

// ── 세대 ────────────────────────────────────────────────────────────────

/** hintPrompt.ts 소스(한 버전)의 세대 해시 — promptVersion.ts의 promptVersionOf()와 같은 계산. */
export function promptVersionOf(tsSource) {
  const ts = require('typescript');
  const js = ts.transpileModule(tsSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports }, { timeout: 1000 });
  const hintSystem = mod.exports.hintSystem;
  const canonical = hintSystem(1, '{category}', 5) + '\u0000' + hintSystem(2, '{category}', 5);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 8);
}

/** main(현재 HEAD)의 1차 부모 이력에서 프롬프트 파일이 바뀐 시점들 — 오래된 순. */
export function promptTimeline(lang = 'ko') {
  const file = PROMPT_FILES[lang];
  const log = execSync(`git log --first-parent --format=%H%x09%cI HEAD -- ${file}`, { encoding: 'utf8' }).trim();
  if (!log) return [];
  return log
    .split('\n')
    .map((line) => {
      const [sha, iso] = line.split('\t');
      let version;
      try {
        version = promptVersionOf(execSync(`git show ${sha}:${file}`, { encoding: 'utf8' }));
      } catch {
        version = `c-${sha.slice(0, 7)}`; // 그 시점 파일이 없거나 형태가 달라 계산 못 함
      }
      return { sha, at: new Date(iso), version };
    })
    .reverse();
}

function versionAt(timeline, date) {
  let found = BEFORE;
  for (const t of timeline) if (t.at <= date) found = t.version;
  return found;
}

// ── 이슈 ────────────────────────────────────────────────────────────────

function repoName() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
    const m = url.match(/github\.com[:/](.+?)(\.git)?$/);
    if (m) return m[1];
  } catch {
    /* 아래 기본값 */
  }
  return 'synurus/fiveclues-ai';
}

export function parseFeedback(body) {
  const m = [...(body ?? '').matchAll(/```json\n([\s\S]*?)\n```/g)].pop();
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** 'feedback' 라벨 이슈 전부(열림·닫힘) → [{ number, createdAt, data }]. */
export async function fetchFeedbackIssues({ repo = repoName(), token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN } = {}) {
  const headers = { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const out = [];
  for (let page = 1; page <= 30; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues?labels=feedback&state=all&per_page=100&page=${page}&sort=created&direction=asc`,
      { headers },
    );
    if (!res.ok) throw new Error(`이슈 목록 조회 실패 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const batch = await res.json();
    for (const issue of batch) {
      if (issue.pull_request) continue;
      const data = parseFeedback(issue.body);
      if (data) out.push({ number: issue.number, createdAt: new Date(issue.created_at), data });
    }
    if (batch.length < 100) break;
  }
  return out;
}

// ── 집계 ────────────────────────────────────────────────────────────────

export function sourceOf(data) {
  if (data.nickname !== AI_NICKNAME && !data.guesserModel) return '사람';
  return /gemini/i.test(data.guesserModel ?? '') ? 'AI(제미나이 추측)' : 'AI(Groq 추측)';
}

/** 윌슨 95% 신뢰구간(비율이 0·1에 가깝거나 표본이 작아도 쓸 만하다). */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function emptyStats() {
  return { n: 0, round1: 0, round2: 0, failed: 0, useless: 0, shown: 0 };
}

function add(stats, data) {
  stats.n += 1;
  stats[data.outcome] = (stats[data.outcome] ?? 0) + 1;
  const useless = Array.isArray(data.uselessHintIndexes)
    ? data.uselessHintIndexes.length
    : typeof data.uselessHintIndex === 'number'
      ? 1
      : 0;
  stats.useless += useless;
  stats.shown += Array.isArray(data.hints) ? data.hints.length : 0;
}

const pct = (x) => `${Math.round(x * 100)}%`;
function rate(k, n) {
  if (!n) return '-';
  const [lo, hi] = wilson(k, n);
  return `${pct(k / n)} (${Math.round(lo * 100)}–${Math.round(hi * 100)})`;
}
function row(label, s) {
  return `| ${label} | ${s.n} | ${rate(s.round1, s.n)} | ${rate(s.round1 + s.round2, s.n)} | ${s.shown ? pct(s.useless / s.shown) : '-'} |`;
}
const HEAD = '| 세대 | 판 | 1라운드 정답률 | 최종 정답률 | 무쓸모율 |\n|---|---:|---:|---:|---:|';

/**
 * items: fetchFeedbackIssues() 결과, timeline: promptTimeline() 결과.
 * 이슈마다 세대(기록된 값 → 없으면 시각으로 소급)와 출처를 붙여 묶는다.
 */
export function aggregate(items, timeline, lang = 'ko') {
  const gens = new Map(); // version → { firstAt, bySource: Map }
  // 세대 순서는 이력에 처음 나타난 시각 순
  for (const t of timeline) if (!gens.has(t.version)) gens.set(t.version, { firstAt: t.at, bySource: new Map() });
  const byModel = new Map();
  const byCategory = new Map();
  const humanEarly = new Map(); // version → stats (사람, 처음 3판 이내)

  let easySkipped = 0;
  for (const { createdAt, data } of items) {
    if ((data.lang ?? 'ko') !== lang || !['round1', 'round2', 'failed'].includes(data.outcome)) continue;
    // 쉬움 모드(1라운드부터 카테고리 공개)는 1라운드 정답률의 조건이 달라 세대 비교에서 뺀다.
    if (data.easy) {
      easySkipped += 1;
      continue;
    }
    const version = data.promptVersion || versionAt(timeline, createdAt);
    if (!gens.has(version)) gens.set(version, { firstAt: version === BEFORE ? new Date(0) : createdAt, bySource: new Map() });
    const g = gens.get(version);
    const src = sourceOf(data);
    if (!g.bySource.has(src)) g.bySource.set(src, emptyStats());
    add(g.bySource.get(src), data);

    if (src === '사람' && typeof data.playCount === 'number' && data.playCount <= 3) {
      if (!humanEarly.has(version)) humanEarly.set(version, emptyStats());
      add(humanEarly.get(version), data);
    }
    const model = data.hintModels?.[0];
    if (model) {
      // "groq:"/"gemini:"만 떼고 "pregen:"(미리 만든 세트)은 남긴다 — 실시간 생성과 구분해 보려고.
      const key = `${version} · ${model.replace(/^(groq|gemini):/, '')}`;
      if (!byModel.has(key)) byModel.set(key, { version, stats: emptyStats() });
      add(byModel.get(key).stats, data);
    }
    if (!byCategory.has(data.category)) byCategory.set(data.category, emptyStats());
    add(byCategory.get(data.category), data);
  }
  const ordered = [...gens.entries()].filter(([, g]) => g.bySource.size).sort((a, b) => a[1].firstAt - b[1].firstAt);
  return { ordered, byModel, byCategory, humanEarly, easySkipped };
}

const kst = (d) =>
  d.getTime() === 0 ? '-' : new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');

/** 사람이 읽을 전체 성적표(마크다운). */
export function formatReport({ ordered, byModel, byCategory, humanEarly, easySkipped = 0 }, { lang = 'ko', generations = Infinity } = {}) {
  const shown = ordered.slice(-generations);
  const lines = [`# 출제 프롬프트 세대별 성적 (${lang === 'ko' ? '한국어' : '영어'})`, ''];
  lines.push(
    '괄호는 95% 신뢰구간. 무쓸모율 = 👎 수 ÷ 보여 준 묘사 수. 피드백을 남긴 판만 집계된다.' +
      (easySkipped ? ` 쉬움 모드 판 ${easySkipped}개는 뺐다.` : ''),
    '',
  );
  lines.push('| 세대 | 처음 반영(KST) |', '|---|---|');
  for (const [v, g] of shown) lines.push(`| ${v} | ${kst(g.firstAt)} |`);
  for (const src of ['사람', 'AI(제미나이 추측)', 'AI(Groq 추측)']) {
    const rows = shown.filter(([, g]) => g.bySource.has(src)).map(([v, g]) => row(v, g.bySource.get(src)));
    if (!rows.length) continue;
    lines.push('', `## ${src}`, '', HEAD, ...rows);
    if (src === '사람') {
      const early = shown.filter(([v]) => humanEarly.has(v)).map(([v]) => row(v, humanEarly.get(v)));
      if (early.length) lines.push('', '사람 중 그 브라우저의 처음 3판만(반복 플레이 요령 제외):', '', HEAD, ...early);
    }
  }
  const latest = shown.at(-1)?.[0];
  const modelRows = [...byModel.values()].filter((m) => m.version === latest);
  if (modelRows.length) {
    lines.push('', `## 최근 세대(${latest}) — 1라운드 출제 모델별 (사람+AI)`, '', HEAD.replace('세대', '모델'));
    for (const [key, m] of byModel) if (m.version === latest) lines.push(row(key.split(' · ')[1], m.stats));
  }
  const cats = [...byCategory.entries()].filter(([, s]) => s.n >= 5).sort((a, b) => a[1].round1 / a[1].n - b[1].round1 / b[1].n);
  if (cats.length) {
    lines.push('', '## 카테고리별 (전 기간·전 출처, 5판 이상, 1라운드 정답률 낮은 순)', '', HEAD.replace('세대', '카테고리'));
    for (const [c, s] of cats) lines.push(row(c, s));
  }
  return lines.join('\n');
}

/** 한 세대로 쌓인 판 수(사람+AI, 쉬움 모드 제외) — propose.mjs의 머지 기준(기획서 v3 §5). */
export function generationGames(agg, version) {
  const g = agg.ordered.find(([v]) => v === version)?.[1];
  return g ? [...g.bySource.values()].reduce((sum, s) => sum + s.n, 0) : 0;
}

/** 자가개선 PR 본문용 — 최근 3세대만, 짧게. */
export async function reportForPr() {
  const items = await fetchFeedbackIssues();
  const agg = aggregate(items, promptTimeline('ko'), 'ko');
  return formatReport({ ...agg, byCategory: new Map() }, { lang: 'ko', generations: 3 }).replace(/^# .*\n\n/, '');
}

// ── CLI ─────────────────────────────────────────────────────────────────

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const lang = arg('--lang') === 'en' ? 'en' : 'ko';
  const items = await fetchFeedbackIssues();
  const report = formatReport(aggregate(items, promptTimeline(lang), lang), { lang });
  console.log(report);
  const out = arg('--out');
  if (out) await writeFile(out, report + '\n');
}
