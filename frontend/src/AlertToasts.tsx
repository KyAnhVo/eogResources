// Pop-up alerts over the map, played along with the replay (driven by the state at "now"). A card stays
// up for SHOW_S of recording time after its last change.
// - With our early alerts: a leak or worn pump pops up at the early (suspected) alert, then the same card
//   turns "confirmed", showing how much earlier our alert came. A pump failure that a worn-pump warning
//   preceded says how far ahead it was predicted.
// - Without (standard check only): a leak pops up only when confirmed, worn pumps never pop up, and a pump
//   failure arrives with no warning. Switching modes on the same moment shows the difference.

import { eventKey, type DetectedEvent, type EventsResponse } from "./api";
import { earlyWarnings, hoursText, warningIndex } from "./early";
import { CATEGORY_LABEL } from "./panels";
import { hhmm } from "./status";

const SHOW_S = 3 * 3600;
const MAX_CARDS = 4;

interface Card {
  e: DetectedEvent;
  confirmed: boolean;
  shownAt: number; // when the card (or its last stage) appeared
}

export function AlertToasts({ state, early, onSelect }: {
  state: EventsResponse; // recorded, as of "now"
  early: boolean;
  onSelect: (e: DetectedEvent) => void;
}) {
  const now: number = state.now_unix;
  const links = warningIndex(earlyWarnings(state.events));
  const cards: Card[] = state.events
    .flatMap((e): Card[] => {
      if (e.category === "pump_failure") return e.onset_unix <= now ? [{ e, confirmed: true, shownAt: e.onset_unix }] : [];
      if (!early && e.category === "pump_degradation") return []; // no warning without our system
      const confirmed: boolean = e.confirmed_unix !== null && e.confirmed_unix <= now;
      if (!early) return confirmed ? [{ e, confirmed, shownAt: e.confirmed_unix ?? 0 }] : [];
      if (e.alarm_unix > now) return [];
      return [{ e, confirmed, shownAt: confirmed ? (e.confirmed_unix ?? 0) : e.alarm_unix }];
    })
    // Unconfirmed early alerts stay up while ongoing; everything else for SHOW_S.
    .filter((c) => (!c.confirmed && c.e.status === "ongoing") || now - c.shownAt <= SHOW_S)
    .sort((a, b) => b.shownAt - a.shownAt)
    .slice(0, MAX_CARDS);
  if (!cards.length) return null;
  return (
    <div className="toasts" aria-live="polite">
      {cards.map(({ e, confirmed, shownAt }) => {
        const fresh: boolean = now - shownAt < 1800;
        const label: string = CATEGORY_LABEL[e.category].toLowerCase();
        if (e.category === "pump_failure") {
          const lead: number | undefined = links.get(eventKey(e))?.leadHours;
          const predicted: boolean = early && lead !== undefined && lead > 0;
          return (
            <button key={eventKey(e)} className={`toast pump_failure ${predicted ? "predicted" : "unwarned"} ${fresh ? "fresh" : ""}`} onClick={() => onSelect(e)}>
              <span className="toast-title">✕ Pump failure · {e.asset_id}</span>
              <span className="toast-steps">
                <span className="step done">Fault {hhmm(e.onset_unix)}</span>
              </span>
              <span className="toast-lead">
                {predicted
                  ? `⚑ Predicted: our wear warning came ${hoursText(lead ?? 0)} ahead`
                  : early
                    ? "Sudden fault: no wear came before it"
                    : "No warning beforehand"}
              </span>
            </button>
          );
        }
        if (!early) {
          return (
            <button key={eventKey(e)} className={`toast ${e.category} standard ${fresh ? "fresh" : ""}`} onClick={() => onSelect(e)}>
              <span className="toast-title">{CATEGORY_LABEL[e.category]} detected · {e.asset_id}</span>
              <span className="toast-steps">
                <span className="step done">Standard check {hhmm(e.confirmed_unix ?? 0)}</span>
              </span>
              <span className="toast-lead muted">No earlier alert</span>
            </button>
          );
        }
        const lead: number | null = confirmed ? Math.round(((e.confirmed_unix ?? 0) - e.alarm_unix) / 60) : null;
        return (
          <button
            key={eventKey(e)}
            className={`toast ${e.category} ${confirmed ? "confirmed" : "suspected"} ${fresh ? "fresh" : ""}`}
            onClick={() => onSelect(e)}
          >
            <span className="toast-title">
              {confirmed ? "✓ Confirmed" : "⚠ Suspected"} {label} · {e.asset_id}
            </span>
            <span className="toast-steps">
              <span className="step done">⚠ Early alert {hhmm(e.alarm_unix)}</span>
              <span className="arrow">→</span>
              <span className={`step ${confirmed ? "done" : "waiting"}`}>
                {confirmed ? `✓ Confirmed ${hhmm(e.confirmed_unix ?? 0)}` : "confirming…"}
              </span>
            </span>
            {lead !== null && lead > 0 && <span className="toast-lead">Our alert came {lead} min before confirmation</span>}
            {!confirmed && <span className="toast-lead">Act now: not yet confirmed by the standard check</span>}
          </button>
        );
      })}
    </div>
  );
}
