// 지난 문제 목록(2026-09-29). 서버 목록(날짜·번호만)에서 이 기기 날짜보다 앞선 것만 보여 주고,
// 이 브라우저에서 이미 푼 문제엔 결과를 표시한다(history.ts). 고르면 onPlay로 넘긴다.
import { useEffect, useState } from 'react';
import Button from '../components/Button';
import { listDaily } from './api';
import { localDate } from './daily';
import { puzzleResults, OUTCOME_EMOJI } from './history';
import { strings, type Lang } from './i18n';

type Puzzle = { date: string; number: number };

export function ArchiveView({ lang, onPlay, onBack }: { lang: Lang; onPlay: (p: Puzzle) => void; onBack: () => void }) {
  const s = strings[lang];
  const [puzzles, setPuzzles] = useState<Puzzle[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    listDaily(lang)
      .then((res) => alive && setPuzzles(res.puzzles.filter((p) => p.date < localDate())))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [lang]);

  const results = puzzleResults(lang);

  return (
    <>
      <p className="wg-daily-title">{s.archive}</p>
      <p className="wg-notice">{s.archiveHint}</p>
      {failed ? (
        <p className="wg-notice">{s.errors.generic}</p>
      ) : !puzzles ? (
        <p className="text-muted">{s.loading}</p>
      ) : !puzzles.length ? (
        <p className="wg-notice">{s.archiveEmpty}</p>
      ) : (
        <ul className="wg-archive">
          {puzzles.map((p) => {
            const done = results.get(p.number);
            return (
              <li key={p.date}>
                <button type="button" onClick={() => onPlay(p)}>
                  <span className="wg-archive-num">#{p.number}</span>
                  <span className="wg-archive-date">{s.archiveDate(p.date)}</span>
                  <span className="wg-archive-state">{done ? OUTCOME_EMOJI[done] : s.archivePlay}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Button variant="secondary" block onClick={onBack}>
        {s.back}
      </Button>
    </>
  );
}
