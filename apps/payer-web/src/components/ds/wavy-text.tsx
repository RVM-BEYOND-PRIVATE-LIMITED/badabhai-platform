/**
 * BadaBhai Design System — WavyText.
 *
 * Renders a string as per-letter spans that bob in a staggered, continuous sine wave.
 * SHARED + presentational (no hooks, no handlers) so it renders on the server. The full
 * string is read once by assistive tech via a visually-hidden copy; the animated letters
 * are `aria-hidden`. The wave collapses to static under prefers-reduced-motion (handled in
 * CSS, `.wavy__ch`). Deterministic output → no hydration mismatch.
 */
const NBSP = " ";

export interface WavyTextProps {
  text: string;
  className?: string;
}

export function WavyText({ text, className = "" }: WavyTextProps) {
  const chars = Array.from(text);
  return (
    <span className={["wavy", className].filter(Boolean).join(" ")}>
      <span className="sr-only">{text}</span>
      <span className="wavy__chars" aria-hidden="true">
        {chars.map((ch, i) => (
          <span key={i} className="wavy__ch" style={{ animationDelay: `${i * 70}ms` }}>
            {ch === " " ? NBSP : ch}
          </span>
        ))}
      </span>
    </span>
  );
}
