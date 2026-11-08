// Oilgorithm mark: an oil drop with a rising data line inside (signal → insight).

export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`logo ${className}`} width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Oilgorithm logo">
      <defs>
        <linearGradient id="oil-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a3f47" />
          <stop offset="1" stopColor="#0b0d10" />
        </linearGradient>
        <linearGradient id="oil-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f59e0b" />
          <stop offset="1" stopColor="#ea580c" />
        </linearGradient>
      </defs>
      <path d="M32 4 C32 4 12 28 12 41 a20 20 0 0 0 40 0 C52 28 32 4 32 4 Z" fill="url(#oil-fill)" stroke="#ea580c" strokeWidth="2.5" />
      <path d="M20 47 L27 40 L32 43 L39 33 L45 36" fill="none" stroke="url(#oil-line)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="45" cy="36" r="3" fill="#f59e0b" />
      <ellipse cx="24" cy="30" rx="3" ry="6" fill="#ffffff" opacity="0.18" transform="rotate(20 24 30)" />
    </svg>
  );
}
