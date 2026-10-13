import { Link } from 'react-router-dom';
import { STATUS_LABEL, fmtSec } from '../../lib/format.js';

// One tile per report, coloured by its latest refresh and marked when its latest load time is over the limit. The status is also a
// drawn symbol (tick, cross, clock, question mark), so a colour-blind reader can tell the tiles apart. Each tile opens its report.
const GLYPH = {
  SUCCESS: 'M5 12.5l4.5 4.5L19 7.5',
  FAILED: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  TIMED_OUT: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4.5l3 1.8',
  UNKNOWN: 'M9.4 9.6a2.7 2.7 0 1 1 3.9 2.4c-.9.5-1.3 1.1-1.3 2M12 17.6v.1',
};
const TONE = { SUCCESS: 'success', FAILED: 'danger', TIMED_OUT: 'danger', UNKNOWN: 'muted' };

export const slowReading = (r, threshold) => Number.isFinite(r.latest_load_time_sec) && r.latest_load_time_sec > threshold;

function Glyph({ status, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={GLYPH[status] ?? GLYPH.UNKNOWN} />
    </svg>
  );
}

export function FleetMap({ reports, threshold = 15 }) {
  const present = ['SUCCESS', 'FAILED', 'TIMED_OUT', 'UNKNOWN'].filter((s) => reports.some((r) => r.last_refresh_status === s));
  return (
    <div className="fleetmap">
      <ul className="tiles" aria-label={`Fleet map: ${reports.length} reports`}>
        {reports.map((r) => {
          const slow = slowReading(r, threshold);
          const status = GLYPH[r.last_refresh_status] ? r.last_refresh_status : 'UNKNOWN';
          const name = `${r.report_id}: refresh ${(STATUS_LABEL[status] ?? status).toLowerCase()}, load time ${fmtSec(r.latest_load_time_sec)}${slow ? ' (over the limit)' : ''}`;
          return (
            <li key={r.report_id}>
              <Link className={`tile tile-${TONE[status]}${slow ? ' tile-slow' : ''}`} to={`/reports/${r.report_id}`} aria-label={name} title={name}>
                <Glyph status={status} />
                <span className="tile-id" aria-hidden="true">{r.report_id.replace(/^RPT_/, '')}</span>
                {slow && <span className="tile-dot" aria-hidden="true" />}
              </Link>
            </li>
          );
        })}
      </ul>
      <ul className="legend legend-small" aria-hidden="true">
        {present.map((s) => <li key={s}><span className={`tile-key tile-${TONE[s]}`}><Glyph status={s} size={13} /></span>{STATUS_LABEL[s]}</li>)}
        <li><span className="tile-key"><span className="tile-dot tile-dot-static" /></span>Latest load over {threshold} s</li>
      </ul>
    </div>
  );
}
