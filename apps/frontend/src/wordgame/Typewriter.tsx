// 한 글자씩 찍어 보여준다 — "실제로 입력하는 것처럼"(기획서 v2 2026-09-15 개편).
// text가 바뀌면 처음부터 다시 찍는다. 힌트마다 key를 다르게 줘서 쓰는 걸 전제한다.
import { useEffect, useRef, useState } from 'react';

const CHAR_MS = 35;

interface TypewriterProps {
  text: string;
  onDone?: () => void;
}

export function Typewriter({ text, onDone }: TypewriterProps) {
  // 진행 글자 수를 "어느 text의 진행인지"와 같이 들고 있다가, text가 바뀌면 0부터로
  // 본다 — 예전엔 이펙트에서 setShown(0)으로 되돌렸는데, 이펙트 안의 동기 setState는
  // 렌더를 한 번 더 일으켜서 react-hooks 규칙이 막는다(2026-09-27 lint 정리).
  const [progress, setProgress] = useState({ text, shown: 0 });
  const shown = progress.text === text ? progress.shown : 0;

  // onDone을 이펙트 deps에 그대로 넣으면 부모가 매 렌더 새 함수를 넘길 때마다
  // 이펙트가 다시 걸려 already-done 판정을 반복 호출한다. ref로 최신 값만 참조한다
  // (렌더 중에 ref를 쓰면 안 돼서 갱신은 이펙트에서 — 아래 이펙트보다 먼저 선언).
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    if (shown >= text.length) {
      if (text.length > 0) onDoneRef.current?.();
      return;
    }
    const timer = setTimeout(() => setProgress({ text, shown: shown + 1 }), CHAR_MS);
    return () => clearTimeout(timer);
  }, [shown, text]);

  return <span>{text.slice(0, shown)}</span>;
}
