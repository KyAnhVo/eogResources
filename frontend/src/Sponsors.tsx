// Sponsor strip for the header: each sponsor's own logo file (frontend/public/sponsors/, served at
// /sponsors/) on a plate the colour of the logo's own background, with the name under it. A monogram
// stands in until the file exists. 8090-mark.png is 8090.png cropped to the logo.

import { useState } from "react";

const SPONSORS: { name: string; file: string; initials: string; plate: string }[] = [
  { name: "EOG Resources", file: "/sponsors/eog.png", initials: "EOG", plate: "#ffffff" },
  { name: "8090", file: "/sponsors/8090-mark.png", initials: "80", plate: "#1c1c1c" },
  { name: "Photon", file: "/sponsors/photon.png", initials: "P", plate: "#000000" },
  { name: "MLH", file: "/sponsors/mlh.png", initials: "MLH", plate: "#ffffff" },
];

function SponsorLogo({ name, file, initials, plate }: { name: string; file: string; initials: string; plate: string }) {
  const [missing, setMissing] = useState<boolean>(false);
  return (
    <figure className="sponsor" title={name}>
      <div className="sponsor-plate" style={{ background: missing ? undefined : plate }}>
        {missing ? (
          <span className="sponsor-mono" aria-hidden="true">{initials}</span>
        ) : (
          <img src={file} alt="" onError={() => setMissing(true)} />
        )}
      </div>
      <figcaption>{name}</figcaption>
    </figure>
  );
}

export function SponsorStrip() {
  return (
    <div className="header-sponsors" aria-label="Sponsors">
      <span className="sponsored-by">Sponsored by</span>
      <div className="sponsor-row">
        {SPONSORS.map((s) => (
          <SponsorLogo key={s.name} {...s} />
        ))}
      </div>
    </div>
  );
}
