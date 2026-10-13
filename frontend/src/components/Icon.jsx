// A small set of line icons, drawn on a 24-point grid. They only ever sit next to text or a number, so they are hidden from assistive
// technology: nothing is communicated by an icon alone.
const PATHS = {
  grid: 'M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  bell: 'M6 9a6 6 0 1 1 12 0c0 6 2 7 2 7H4s2-1 2-7M10 20a2 2 0 0 0 4 0',
  coin: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v10M15 9.5c0-1-1.3-1.7-3-1.7s-3 .8-3 2 1.3 1.6 3 2 3 .8 3 2-1.3 2-3 2-3-.7-3-1.7',
  userOff: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-6 8-6s8 2 8 6M3 3l18 18',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4',
  sparkles: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  cross: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  help: 'M9.4 9.6a2.7 2.7 0 1 1 3.9 2.4c-.9.5-1.3 1.1-1.3 2M12 17.6v.1',
};

export function Icon({ name, size = 20, className = '' }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg className={`icon ${className}`.trim()} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}
