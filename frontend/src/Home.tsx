// Homepage, shown before a dataset folder is chosen. Content follows ideas.md: the problem, what
// Oilgorithm does, why early detection, how we deliver it, risk-matched control, and where it scales.

import type { ReactNode } from "react";
import { Logo } from "./Logo";

// What Oilgorithm sets out to do (ideas.md, "Project goals").
const GOALS: { icon: string; title: string; text: string; tone: string }[] = [
  {
    icon: "📍",
    title: "Locate the failure",
    text: "Pinpoint where in the network it is happening: the facility, the pump or the pipeline, on a live map.",
    tone: "accent",
  },
  {
    icon: "⚠",
    title: "Detect it early",
    text: "Catch pipeline leaks in their early stage, at the first pressure drop, before they grow into a spill.",
    tone: "leak",
  },
  {
    icon: "◉",
    title: "Validate pump wear",
    text: "Hold the inspector until several signals agree the pump is really wearing, so every trip finds a real problem.",
    tone: "ok",
  },
  {
    icon: "🚚",
    title: "Choose the cheapest response",
    text: "Rank the possible responses by cost and reach the right people automatically, with control matched to the risk.",
    tone: "wear",
  },
];

// ideas.md, "Why is it matter?"
const WHY: { q: string; cost: string; value: string }[] = [
  {
    q: "Why catch failures early instead of predicting them?",
    cost: "Predicting a leak before it starts means guessing from readings that show no real sign: false alarms and wasted inspector trips.",
    value: "Little damage happens before a leak begins. Catching it right after it starts, while it is still small, is the cheapest moment to fix it.",
  },
  {
    q: "Why not send the inspector the moment a pump looks worn?",
    cost: "A worn pump's first signal is so small that an inspector sent right away may find nothing. We wait until the pumped volume keeps dropping.",
    value: "Once confirmed, the inspector arrives at a real problem they can find and fix, well before the pump fails and the tank starts filling.",
  },
];

// ideas.md, "System design": what the console delivers.
const DELIVER: { title: string; text: string }[] = [
  { title: "Facility map", text: "Every facility, tank, pump and pipeline, colored by its worst problem, so the failure's position is obvious." },
  { title: "Early alerts", text: "Where the leak or worn pump is, what happens next, and a countdown to when it does." },
  { title: "Pump wear validation", text: "Each alarm moves from suspected to confirmed to verified as flow and tank drain agree." },
  { title: "Response decisions", text: "Every option is costed; the cheapest one that keeps tanks running is chosen, with the reasons shown." },
  { title: "Automatic crew notifications", text: "The supervisor, drivers, inspectors and operators are told the moment they are needed." },
  { title: "Incident report", text: "Every incident with alert and confirmation times, time saved, decisions and who was notified." },
  { title: "On any phone", text: "A view-only live page follows the control-room console from anywhere, through our own domain." },
];

// ideas.md, "Agentic AI decision-making": control matched to risk.
const TIERS: { level: string; examples: string; rule: string; tone: string }[] = [
  {
    level: "Safe and reversible",
    examples: "Open a diversion valve to a tank with room, slow a pump, isolate a pipeline segment",
    rule: "Acts immediately, then notifies the operator, who can undo it in one click.",
    tone: "ok",
  },
  {
    level: "Costly but reversible",
    examples: "Throttle wells, call a water truck",
    rule: "Recommends and waits for approval; if nobody answers and the countdown is short, takes the safest default.",
    tone: "wear",
  },
  {
    level: "Expensive or irreversible",
    examples: "Dispatch an emergency crew, shut in the field",
    rule: "Always needs a human to approve.",
    tone: "leak",
  },
];

const SCALE: { title: string; text: string }[] = [
  { title: "Data center cooling", text: "A weakening pump, a slow coolant leak or rising coolant temperature, with a countdown until servers overheat." },
  { title: "Electrical supply", text: "A transformer slowly overheating or a backup battery weakening, with a countdown until power could fail." },
];

/** Leak: our alert before the standard check. Pump: wear flagged well before it fails. */
function Illustration() {
  return (
    <svg className="home-illus" viewBox="0 0 520 170" role="img" aria-label="Our alert comes before the standard check; the wear warning comes more than a day before the pump fails">
      <text x="0" y="16" className="il-head">Leak</text>
      <line x1="60" y1="38" x2="510" y2="38" className="il-axis" />
      <rect x="120" y="33" width="390" height="10" rx="5" className="il-leak" />
      <text x="120" y="62" className="il-tick">leak starts</text>
      <circle cx="175" cy="38" r="8" className="il-ours" />
      <text x="175" y="22" textAnchor="middle" className="il-ours-t">⚠ our alert</text>
      <circle cx="245" cy="38" r="6" className="il-std" />
      <text x="262" y="62" textAnchor="middle" className="il-std-t">standard check</text>

      <text x="0" y="104" className="il-head">Pump</text>
      <line x1="60" y1="126" x2="510" y2="126" className="il-axis" />
      <rect x="120" y="121" width="300" height="10" rx="5" className="il-wear" />
      <rect x="420" y="121" width="90" height="10" rx="5" className="il-fail" />
      <path d="M120 140 L420 140" className="il-span" markerEnd="url(#il-arrow)" />
      <text x="270" y="158" textAnchor="middle" className="il-span-t">⚑ warned more than a day ahead</text>
      <text x="120" y="110" className="il-tick">wear flagged</text>
      <text x="420" y="110" className="il-tick">✕ fails</text>
      <defs>
        <marker id="il-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" className="il-arrowhead" />
        </marker>
      </defs>
    </svg>
  );
}

export function HomePage({ picker }: { picker: ReactNode }) {
  return (
    <main className="home">
      <section className="home-hero">
        <div className="hero-text">
          <div className="hero-brand">
            <Logo size={56} />
          </div>
          <p className="eyebrow">Water disposal network monitor</p>
          <h2>Find failures early, where they are, and act at the lowest cost.</h2>
          <p className="lede">
            Today the salt-water system only reports a failure when a sensor crosses a hard limit, and by then the damage is
            already growing. Oilgorithm locates the problem, catches it at its early stage, and drives the cheapest response.
          </p>
          <div className="hero-cta">
            {picker}
            <span className="muted">Pick a folder with network.json, ops.json and telemetry.csv. Files stay on this machine.</span>
          </div>
        </div>
        <Illustration />
      </section>

      <section>
        <h3 className="home-h">What Oilgorithm does</h3>
        <div className="home-achieve">
          {GOALS.map((g) => (
            <div key={g.title} className={`home-card ${g.tone}`}>
              <span className="card-icon" aria-hidden="true">{g.icon}</span>
              <strong>{g.title}</strong>
              <p>{g.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="home-h">Why it matters</h3>
        <div className="home-why">
          {WHY.map((w) => (
            <div key={w.q} className="why-card">
              <strong>{w.q}</strong>
              <p><span className="why-tag cost">Cost</span>{w.cost}</p>
              <p><span className="why-tag value">Value</span>{w.value}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="home-h">How we deliver it</h3>
        <ol className="home-journey">
          {DELIVER.map((d, i) => (
            <li key={d.title}>
              <span className="jr-num">{i + 1}</span>
              <div>
                <strong>{d.title}</strong>
                <p>{d.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h3 className="home-h">Control matched to risk</h3>
        <p className="home-sub muted">
          How the response agent is designed to act. In this build it ranks the options and notifies the crew automatically;
          approvals and valve control are the next step.
        </p>
        <div className="home-tiers">
          {TIERS.map((t) => (
            <div key={t.level} className={`tier ${t.tone}`}>
              <strong>{t.level}</strong>
              <span className="tier-ex">{t.examples}</span>
              <p>{t.rule}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="home-h">Without vs with Oilgorithm</h3>
        <table className="home-compare">
          <thead>
            <tr>
              <th />
              <th>Hard-limit alarms today</th>
              <th>⚠ With Oilgorithm</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Pipeline leak</th>
              <td className="without">Reported once a sensor crosses its limit</td>
              <td className="with">Alert at the first pressure drop, with where and how long</td>
            </tr>
            <tr>
              <th scope="row">Pump wearing out</th>
              <td className="without">Unnoticed until it breaks</td>
              <td className="with">Validated wear and a countdown to failure</td>
            </tr>
            <tr>
              <th scope="row">Response</th>
              <td className="without">Trucks and shut-ins after the fact</td>
              <td className="with">Cheapest plan, the right people told at once</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h3 className="home-h">Beyond water</h3>
        <div className="home-why">
          {SCALE.map((x) => (
            <div key={x.title} className="why-card">
              <strong>{x.title}</strong>
              <p>{x.text}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
