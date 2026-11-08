// Sends each incident's notifications (Notify.tsx noticesFor) as "now" passes the moment each is needed,
// and shows them on the map as the solution being carried out. Always on: there is no opt-out.
// Each notice goes out once per loaded dataset. A jump of "now" larger than MAX_JUMP_S (loading at the
// end of the recording, dragging far) sends nothing, so loading does not fire the whole week at once.

import { useEffect, useRef, useState } from "react";
import { sendNotify, type Contact, type EventsResponse, type NotifyResult } from "./api";
import { noticesFor, stageIcon, type Notice } from "./Notify";
import { hhmm } from "./status";

const MAX_JUMP_S = 6 * 3600;

export interface Sent {
  notice: Notice;
  result: NotifyResult;
}

export function useAutoNotify(state: EventsResponse | null, contacts: Contact[], early: boolean, loadId: number): Map<string, Sent> {
  const [sent, setSent] = useState<Map<string, Sent>>(new Map());
  const done = useRef<Set<string>>(new Set());
  const prevNow = useRef<number | null>(null);

  useEffect(() => {
    done.current = new Set();
    prevNow.current = null;
    setSent(new Map());
  }, [loadId]);

  useEffect(() => {
    if (!state) return;
    const now: number = state.now_unix;
    const prev: number | null = prevNow.current;
    prevNow.current = now;
    if (!contacts.length || prev === null || now <= prev || now - prev > MAX_JUMP_S) return;
    for (const e of state.events) {
      for (const n of noticesFor(e, contacts, early)) {
        if (n.at <= prev || n.at > now || done.current.has(n.key)) continue;
        done.current.add(n.key);
        sendNotify(e.event_id, n.to.map((c) => c.id), n.message)
          .then((result) => setSent((m) => new Map(m).set(n.key, { notice: n, result })))
          .catch(() => done.current.delete(n.key)); // retried when "now" passes it again
      }
    }
  }, [state, contacts, early]);

  return sent;
}

/** On the map: the latest notifications, shown as the solution being carried out. */
export function SolutionFeed({ notices, now, note = "placeholder sender: not delivered" }: { notices: Notice[]; now: number; note?: string }) {
  const recent: Notice[] = notices
    .filter((n) => n.at <= now && now - n.at <= 3 * 3600)
    .sort((a, b) => b.at - a.at)
    .slice(0, 4);
  if (!recent.length) return null;
  return (
    <div className="notify-feed" aria-live="polite">
      <span className="feed-head">Solution in progress</span>
      {recent.map((n) => (
        <div key={n.key} className={`feed-item ${n.stage}`}>
          <span className="feed-title">
            {stageIcon(n.stage)} {n.title} · {hhmm(n.at)}
          </span>
          <span className="feed-msg">{n.message.replace(/^\[Oilgorithm [^\]]*\] /, "")}</span>
          <span className="feed-to">📨 {n.to.map((c) => `${c.title} ${c.name.replace(" (placeholder)", "")}`).join(" · ")}</span>
        </div>
      ))}
      <span className="feed-note">{note}</span>
    </div>
  );
}
