/**
 * The shape of one role illustration, as the generator emits it (src/generated/role-art-data.ts).
 * Hand-written so the generated file only carries data; the worker app mirrors these types in
 * `role_art_model.dart`.
 */

/** One of the three brand colours (CLAUDE.md design system) — the only colours art may use. */
export type RoleArtColour = "primary" | "accent" | "surface";

/** A CSS-animatable property a motion drives. */
export type RoleArtMotionProp = "rotate" | "translateX" | "translateY" | "scale" | "opacity";

/**
 * A motion in the shared vocabulary: evenly spaced keyframes, each `base + key * amp`, eased
 * per segment (`ease-in-out` = cubic-bezier(.42,0,.58,1) = Flutter's `Curves.easeInOut`).
 * The first keyframe is the rest pose — the reduce-motion frame.
 */
export interface RoleArtMotionSpec {
  readonly prop: RoleArtMotionProp;
  readonly base: number;
  readonly keys: readonly number[];
  readonly easing: "ease-in-out" | "linear";
}

/** One moving part's motion: which vocabulary entry, how far, about which point, how often. */
export interface RoleArtMotion {
  readonly type: string;
  /** Degrees (rotate), canvas units (translate), a scale delta, or an opacity delta. */
  readonly amp: number;
  /** Transform origin, in canvas units. */
  readonly ox: number;
  readonly oy: number;
  /** Whole cycles per loop, so every loop is seamless. */
  readonly rate: number;
  /** Cycle offset in [0, 1). */
  readonly phase: number;
}

/** One painted shape: normalized absolute path data and its paint. */
export interface RoleArtShape {
  readonly d: string;
  readonly colour: RoleArtColour;
  /** One of 1 / .8 / .6 / .4 — the brand's alpha steps. */
  readonly opacity: number;
  /** 0 = filled; > 0 = a round-capped, round-joined stroke of this width. */
  readonly strokeWidth: number;
}

/** A named group of shapes; static when `motion` is null. */
export interface RoleArtPart {
  readonly name: string;
  readonly motion: RoleArtMotion | null;
  readonly shapes: readonly RoleArtShape[];
}

/** One role's illustration: its loop length (seconds) and its parts, back to front. */
export interface RoleArtDef {
  readonly loop: number;
  readonly parts: readonly RoleArtPart[];
}
