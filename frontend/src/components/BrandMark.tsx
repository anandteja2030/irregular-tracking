interface BrandMarkProps {
  /** Rendered edge length in px. */
  size?: number;
}

/** Shared NEURAL COMMAND glyph: the rail identifies the app, the narrow top bar
 * repeats the same mark so branding survives the bottom-navigation layout. */
export function BrandMark({ size = 19 }: BrandMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.6 21 7.4v9.2L12 21.4 3 16.6V7.4z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        opacity="0.75"
      />
      <path
        d="M12 7.1v9.8M7.6 9.6v4.8M16.4 9.6v4.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  );
}
