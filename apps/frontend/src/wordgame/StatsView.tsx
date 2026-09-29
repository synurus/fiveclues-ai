// 내 기록(2026-09-29) — 이 브라우저에 쌓인 판으로 만든 통계(history.ts·daily.ts). 서버는 모른다.
import Button from '../components/Button';
import { dailySummary, localDate, solvedStreak } from './daily';
import { computeStats, loadHistory, OUTCOME_EMOJI } from './history';
import { strings, type Lang } from './i18n';

const pct = (a: number, b: number): string => (b ? `${Math.round((a / b) * 100)}%` : '-');

export function StatsView({ lang, onBack }: { lang: Lang; onBack: () => void }) {
  const s = strings[lang];
  const stats = computeStats(loadHistory(lang));
  const daily = dailySummary(lang);
  // 정답률 절반 이상이면 "잘 맞히는", 미만이면 "어려워하는" — 카테고리가 몇 개 안 될 때 0% 카테고리가
  // 잘 맞히는 쪽에 끼지 않게(2판 이상 한 카테고리만, history.ts).
  const strong = stats.categories.filter((c) => c.won / c.n >= 0.5).slice(0, 3);
  const weak = [...stats.categories].reverse().filter((c) => c.won / c.n < 0.5).slice(0, 3);

  return (
    <>
      <p className="wg-daily-title">{s.stats}</p>
      {stats.total === 0 ? (
        <p className="wg-notice">{s.statsEmpty}</p>
      ) : (
        <>
          <div className="wg-stats">
            <div>
              <strong>{stats.total}</strong>
              <span>{s.statsGames}</span>
            </div>
            <div>
              <strong>{pct(stats.won, stats.total)}</strong>
              <span>{s.statsWinRate}</span>
            </div>
            <div>
              <strong>{pct(stats.round1, stats.total)}</strong>
              <span>{s.statsRound1}</span>
            </div>
          </div>
          <p className="wg-stats-line">{s.statsDaily(solvedStreak(lang, localDate()), daily.best, daily.days)}</p>
          <p className="wg-stats-line">
            {s.statsRecent} <span className="wg-stats-recent">{stats.recent.map((o) => OUTCOME_EMOJI[o]).join('')}</span>
          </p>
          <p className="wg-notice">{s.statsLegend}</p>
          {strong.length > 0 && (
            <p className="wg-stats-line">
              {s.statsStrong}: {strong.map((c) => `${c.category}(${c.won}/${c.n})`).join(' · ')}
            </p>
          )}
          {weak.length > 0 && (
            <p className="wg-stats-line">
              {s.statsWeak}: {weak.map((c) => `${c.category}(${c.won}/${c.n})`).join(' · ')}
            </p>
          )}
        </>
      )}
      <p className="wg-notice">{s.statsNote}</p>
      <Button variant="secondary" block onClick={onBack}>
        {s.back}
      </Button>
    </>
  );
}
