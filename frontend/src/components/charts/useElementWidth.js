import { useEffect, useRef, useState } from 'react';

// The drawn width of an element, kept up to date as the window or layout changes. Charts draw at their real pixel size so text stays
// readable on a phone instead of being scaled down with the picture. Where there is no layout (tests, old browsers) it keeps the fallback.
export function useElementWidth(fallback = 600) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
