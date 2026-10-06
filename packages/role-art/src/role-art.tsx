import type { CSSProperties } from "react";
import { ROLE_ART_CANVAS, ROLE_ART_DATA, ROLE_ART_PALETTE } from "./generated/role-art-data";
import { resolveRoleArtKind } from "./resolve";
import type { RoleArtMotion } from "./types";

export interface RoleArtProps {
  /** A posting's `role_kind` — any value; unknown/absent draws the generic art. */
  roleKind: unknown;
  /** Animate the moving parts (default). `prefers-reduced-motion` always wins (role-art.css). */
  animated?: boolean;
  className?: string;
}

/** The custom properties role-art.css reads for one moving part. */
function motionStyle(motion: RoleArtMotion, loop: number): CSSProperties {
  const cycle = loop / motion.rate;
  return {
    "--ra-amp": String(motion.amp),
    "--ra-ox": `${motion.ox}px`,
    "--ra-oy": `${motion.oy}px`,
    "--ra-dur": `${cycle}s`,
    // A negative delay starts the cycle part-way in, so a phased part is already in step.
    "--ra-delay": `${-motion.phase * cycle}s`,
  } as CSSProperties;
}

/**
 * THE ROLE ILLUSTRATION — the animated header of a job card, drawn from the SAME generated data
 * the worker app paints, so the payer's preview and the worker's card show one picture.
 *
 * Decorative: `aria-hidden`, no text, no title — the card's own title already names the job,
 * and the art never states anything the posting does not (it shows the role the payer picked,
 * or the generic scene). Stateless and pure; motion is CSS only (role-art.css), honouring
 * `prefers-reduced-motion` by holding every part at its rest pose.
 */
export function RoleArt({ roleKind, animated = true, className }: RoleArtProps) {
  const kind = resolveRoleArtKind(roleKind);
  const def = ROLE_ART_DATA[kind];
  const classes = ["bb-role-art", animated ? "bb-role-art--animated" : null, className]
    .filter(Boolean)
    .join(" ");
  return (
    <svg
      className={classes}
      viewBox={`0 0 ${ROLE_ART_CANVAS.width} ${ROLE_ART_CANVAS.height}`}
      data-role-art={kind}
      aria-hidden="true"
      focusable="false"
    >
      {def.parts.map((part) => (
        <g
          key={part.name}
          data-part={part.name}
          className={
            part.motion ? `bb-role-art__part bb-role-art__part--${part.motion.type}` : undefined
          }
          style={part.motion ? motionStyle(part.motion, def.loop) : undefined}
        >
          {part.shapes.map((shape, i) => {
            const colour = ROLE_ART_PALETTE[shape.colour];
            const opacity = shape.opacity === 1 ? undefined : shape.opacity;
            return shape.strokeWidth > 0 ? (
              <path
                key={i}
                d={shape.d}
                fill="none"
                stroke={colour}
                strokeWidth={shape.strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={opacity}
              />
            ) : (
              <path key={i} d={shape.d} fill={colour} opacity={opacity} />
            );
          })}
        </g>
      ))}
    </svg>
  );
}
