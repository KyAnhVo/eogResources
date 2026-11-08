// Early signals. (1) Suspected vs confirmed: leaks and worn pumps alarm on a fast rule first and are
// confirmed when the standard CUSUM threshold is reached; the gap is how much sooner the alarm came.
// (2) Early warning: a worn-pump alarm is the only signal that precedes a pump failure (research found
// no precursor for leaks or sudden failures). The wear detector stops at the fault row, so a wear
// event that ends exactly when the same pump faults is the warning for that failure.

import { eventKey, type DetectedEvent } from "./api";
import { hhmm } from "./status";

export interface Warning {
  wear: DetectedEvent;
  failure: DetectedEvent | undefined; // undefined: no failure followed (yet, among the given events)
  leadHours: number | undefined; // wear alarm → failure onset
}

/** Every wear event in `events`, linked to the failure it preceded if that failure is in `events`. */
export function earlyWarnings(events: DetectedEvent[]): Warning[] {
  return events
    .filter((e) => e.category === "pump_degradation")
    .map((wear) => {
      const failure: DetectedEvent | undefined = events.find(
        (f) => f.category === "pump_failure" && f.asset_id === wear.asset_id && f.onset_unix === wear.end_unix,
      );
      return { wear, failure, leadHours: failure && (failure.onset_unix - wear.alarm_unix) / 3600 };
    });
}

/** Lookup by event key, for both ends of each link. */
export function warningIndex(warnings: Warning[]): Map<string, Warning> {
  const index = new Map<string, Warning>();
  for (const w of warnings) {
    index.set(eventKey(w.wear), w);
    if (w.failure) index.set(eventKey(w.failure), w);
  }
  return index;
}

export const hoursText = (h: number): string =>
  h >= 10 ? `${Math.round(h)} h` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(h * 60)} min`;

/** Not yet confirmed at `now`. Pump faults are reported by the pump, so they are confirmed at once. */
export const isSuspected = (e: DetectedEvent, now: number): boolean => e.confirmed_unix === null || e.confirmed_unix > now;

/** Minutes between the fast alarm and confirmation; null if not confirmed. */
export const soonerMinutes = (e: DetectedEvent): number | null =>
  e.confirmed_unix === null ? null : Math.round((e.confirmed_unix - e.alarm_unix) / 60);

/** One line on the detection stage, or null when there is nothing early to say (faults, no gap). */
export function stageText(e: DetectedEvent, now: number): string | null {
  if (e.category === "pump_failure") return null;
  if (isSuspected(e, now)) {
    return e.status === "ongoing" || (e.end_unix ?? 0) > now
      ? `suspected ${hhmm(e.alarm_unix)} · not confirmed yet`
      : `suspected ${hhmm(e.alarm_unix)} · never confirmed`;
  }
  const gap: number | null = soonerMinutes(e);
  return gap ? `flagged ${gap} min before confirmation` : null;
}
