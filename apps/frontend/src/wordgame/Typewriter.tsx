// 한 글자씩 찍어 보여준다 — "실제로 입력하는 것처럼"(기획서 v2 2026-09-15 개편).
// text가 바뀌면 처음부터 다시 찍는다. 힌트마다 key를 다르게 줘서 쓰는 걸 전제한다.
import { useEffect, useRef, useState } from 'react';

const CHAR_MS = 35;

interface TypewriterProps {
  text: string;
  onDone?: () => void;
}

export function Typewriter({ text, onDone }: TypewriterProps) {
  const [shown, setShown] = useState(0);
  // onDone을 이펙트 deps에 그대로 넣으면 부모가 매 렌더 새 함수를 넘길 때마다
  // 이펙트가 다시 걸려 already-done 판정을 반복 호출한다. ref로 최신 값만 참조한다.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    setShown(0);
  }, [text]);

  useEffect(() => {
    if (shown >= text.length) {
      if (text.length > 0) onDoneRef.current?.();
      return;
    }
    const timer = setTimeout(() => setShown((n) => n + 1), CHAR_MS);
    return () => clearTimeout(timer);
  }, [shown, text]);

  return <span>{text.slice(0, shown)}</span>;
}
