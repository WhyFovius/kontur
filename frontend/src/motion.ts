import type { Transition, Variants } from "framer-motion";

/**
 * Material Design 3 Expressive motion system.
 * Expressive favors spring physics over fixed durations; springs below map
 * to M3 roles: emphasized (large transforms), standard (everyday),
 * snappy (chips, thumbs, pills). All choreography animates transform and
 * opacity; layout (FLIP) transforms are composited by Framer Motion.
 */
export const springEmphasized: Transition = {
  type: "spring",
  stiffness: 380,
  damping: 34,
  mass: 0.95,
};

export const springStandard: Transition = {
  type: "spring",
  stiffness: 460,
  damping: 38,
  mass: 0.9,
};

export const springSnappy: Transition = {
  type: "spring",
  stiffness: 650,
  damping: 38,
  mass: 0.75,
};

export const springGentle: Transition = {
  type: "spring",
  stiffness: 220,
  damping: 29,
  mass: 1,
};

/** Drag-select thumbs: tight spring that chases the pointer without lag. */
export const springFollow: Transition = {
  type: "spring",
  stiffness: 720,
  damping: 44,
  mass: 0.85,
};

/** Expressive shape morphs use a short overshooting tween; the animated
 * value is a radius/path interpolation on small surfaces, while position
 * and page choreography stay on composited transforms. */
export const shapeMorphTween: Transition = {
  type: "tween",
  duration: 0.45,
  ease: [0.34, 1.45, 0.42, 1],
};

/** M3 emphasized easing as a tween fallback (path morphs, counters). */
export const emphasizedTween: Transition = {
  type: "tween",
  duration: 0.55,
  ease: [0.05, 0.7, 0.1, 1],
};

export const fadeRise: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.985 },
  show: (delay: number = 0) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { ...springEmphasized, delay },
  }),
  exit: {
    opacity: 0,
    y: -10,
    scale: 0.99,
    transition: { duration: 0.18, ease: [0.3, 0, 1, 1] },
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
    transition: springEmphasized,
  },
};

/** Direction-aware page turns for the customer list. */
export const rowPageVariants: Variants = {
  enter: (direction: number) => ({
    opacity: 0,
    x: direction >= 0 ? 28 : -28,
    scale: 0.995,
  }),
  center: { opacity: 1, x: 0, scale: 1, transition: springEmphasized },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction >= 0 ? -18 : 18,
    scale: 0.995,
    transition: { duration: 0.16, ease: [0.3, 0, 1, 1] },
  }),
};

export const pressable = {
  whileHover: { y: -1 },
  whileTap: { scale: 0.97 },
  transition: springSnappy,
} as const;

/** Direction-aware full-page turns (Обзор ⇄ Клиенты ⇄ Модель). */
export const pageVariants: Variants = {
  enter: (direction: number) => ({
    opacity: 0,
    x: direction >= 0 ? 28 : -28,
    scale: 0.995,
  }),
  center: { opacity: 1, x: 0, scale: 1, transition: springEmphasized },
  exit: (direction: number) => ({
    opacity: 0,
    x: direction >= 0 ? -20 : 20,
    scale: 0.995,
    transition: { duration: 0.18, ease: [0.3, 0, 1, 1] },
  }),
};
