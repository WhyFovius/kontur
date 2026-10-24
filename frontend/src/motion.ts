import type { Transition, Variants } from "framer-motion";

/**
 * Material Design 3 motion physics system (M3 Expressive), implemented
 * from the official spring tokens:
 *   m3.material.io/styles/motion/overview (how it works + specs)
 *   androidx Compose Material3 ExpressiveMotionTokens/StandardMotionTokens
 *
 * Compose expresses springs as (stiffness k, dampingRatio ζ). Framer
 * Motion wants (stiffness k, damping c, mass m=1), so c = 2ζ√k:
 *
 *   expressive fast    spatial  k=800  ζ=0.6 → c≈34    effects k=3800 ζ=1 → c≈123
 *   expressive default spatial  k=380  ζ=0.8 → c≈31    effects k=1600 ζ=1 → c=80
 *   expressive slow    spatial  k=200  ζ=0.8 → c≈23    effects k=800  ζ=1 → c≈57
 *   standard   fast    spatial  k=1400 ζ=0.9 → c≈67
 *   standard   default spatial  k=700  ζ=0.9 → c≈48
 *   standard   slow    spatial  k=300  ζ=0.9 → c≈31
 *
 * Spatial springs (position/size/rotation/corner radius) may overshoot;
 * effects springs (opacity/color) never do. Springs are integrated from
 * wall-clock delta, so the same motion takes the same time at 60 Hz and
 * at 360 Hz — higher refresh rates simply sample it more finely. That
 * is why no animation here is ever driven by frame counts or intervals.
 */

/* ----- M3 expressive scheme ----- */
export const springExFastSpatial: Transition = { type: "spring", stiffness: 800, damping: 34, mass: 1 };
export const springExSpatial: Transition = { type: "spring", stiffness: 380, damping: 31, mass: 1 };
export const springExSlowSpatial: Transition = { type: "spring", stiffness: 200, damping: 23, mass: 1 };
export const springExFastEffects: Transition = { type: "spring", stiffness: 3800, damping: 123, mass: 1 };
export const springExEffects: Transition = { type: "spring", stiffness: 1600, damping: 80, mass: 1 };
export const springExSlowEffects: Transition = { type: "spring", stiffness: 800, damping: 57, mass: 1 };

/* ----- M3 standard scheme (utilitarian moments, minimal bounce) ----- */
export const springStdFastSpatial: Transition = { type: "spring", stiffness: 1400, damping: 67, mass: 1 };
export const springStdSpatial: Transition = { type: "spring", stiffness: 700, damping: 48, mass: 1 };
export const springStdSlowSpatial: Transition = { type: "spring", stiffness: 300, damping: 31, mass: 1 };

/* ----- Role aliases used across the app ----- */
/** Hero/large spatial choreography — expressive default spatial. */
export const springEmphasized: Transition = springExSpatial;
/** Everyday utility motion — standard default spatial. */
export const springStandard: Transition = springStdSpatial;
/** Chips, thumbs, icon morphs, presses — expressive fast spatial. */
export const springSnappy: Transition = springExFastSpatial;
/** Large slow surfaces — expressive slow spatial. */
export const springGentle: Transition = springExSlowSpatial;
/** Drag-select thumbs chase the pointer: standard fast spatial (tight,
 * ζ=0.9 so it tracks without visible overshoot past the finger). */
export const springFollow: Transition = springStdFastSpatial;

/** M3 easing set, for the value types springs can't drive (SVG path
 * morphs) and for exits, which the transition patterns spec keeps on
 * emphasized-accelerate tweens. */
export const EASE_EMPHASIZED: [number, number, number, number] = [0.2, 0, 0, 1];
export const EASE_EMPHASIZED_DECELERATE: [number, number, number, number] = [0.05, 0.7, 0.1, 1];
export const EASE_EMPHASIZED_ACCELERATE: [number, number, number, number] = [0.3, 0, 0.8, 0.15];
export const EASE_STANDARD_ACCELERATE: [number, number, number, number] = [0.3, 0, 1, 1];

/** Exit permanently: emphasized-accelerate, 200 ms (short-4). */
export const exitTween: Transition = {
  type: "tween",
  duration: 0.2,
  ease: EASE_EMPHASIZED_ACCELERATE,
};

/** Small shape morphs (corner radius on square tiles): short tween with
 * a touch of overshoot, mirroring the spatial-spring feel in CSS-less
 * contexts. Radius is a paint-time property — keep it to small tiles. */
export const shapeMorphTween: Transition = {
  type: "tween",
  duration: 0.4,
  ease: [0.34, 1.45, 0.42, 1],
};

/** Enter tween fallback (path morphs, counters):
 * emphasized-decelerate, 400 ms (medium-4). */
export const emphasizedTween: Transition = {
  type: "tween",
  duration: 0.4,
  ease: EASE_EMPHASIZED_DECELERATE,
};

/** Enter/exit pattern: rise on the spatial spring, fade on the effects
 * spring (opacity must not overshoot), exit on emphasized-accelerate. */
export const fadeRise: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.985 },
  show: (delay: number = 0) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      default: { ...springExSpatial, delay },
      opacity: { ...springExEffects, delay },
    },
  }),
  exit: {
    opacity: 0,
    y: -8,
    scale: 0.99,
    transition: exitTween,
  },
};

export const staggerParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.055, delayChildren: 0.04 } },
};

export const staggerChild: Variants = {
  hidden: { opacity: 0, y: 14, scale: 0.99 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      default: springExSpatial,
      opacity: springExEffects,
    },
  },
};

/** Lateral pattern (peer content): customer-list page turns slide,
 * grouped, without parallax. Direction-aware. */
export const rowPageVariants: Variants = {
  enter: (direction: number) => ({
    opacity: 0,
    x: direction >= 0 ? 26 : -26,
    scale: 0.995,
  }),
  center: {
    opacity: 1,
    x: 0,
    scale: 1,
    transition: { default: springExSpatial, opacity: springExEffects },
  },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction >= 0 ? -16 : 16,
    scale: 0.995,
    transition: { duration: 0.16, ease: EASE_EMPHASIZED_ACCELERATE },
  }),
};

export const pressable = {
  whileHover: { y: -1 },
  whileTap: { scale: 0.97 },
  transition: springSnappy,
} as const;

/** Top-level pattern (Обзор ⇄ Клиенты ⇄ Модель): fade-through — the
 * outgoing page fades, the incoming one fades in with a slight scale
 * settle. No lateral slide: these are peer destinations, not a stack.
 * The direction argument is accepted for API compatibility and ignored. */
export const pageVariants: Variants = {
  enter: () => ({
    opacity: 0,
    scale: 0.99,
    y: 10,
  }),
  center: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { default: springExSpatial, opacity: springExEffects },
  },
  exit: () => ({
    opacity: 0,
    scale: 0.995,
    y: -6,
    transition: { duration: 0.15, ease: EASE_EMPHASIZED_ACCELERATE },
  }),
};
