import { motion } from "framer-motion";
import { useState, type ReactNode } from "react";
import { springEmphasized, springGentle } from "../motion";

export function AezaLogo({
  compact = false,
  className = "",
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <img
      className={`aeza-logo${compact ? " aeza-logo-compact" : ""} ${className}`.trim()}
      src={compact ? "/static/brand/aeza-symbol.svg" : "/static/brand/aeza-logo.svg"}
      alt="Aéza"
      draggable={false}
    />
  );
}

const LOGO_TILE_OFFSETS = [0, 27, 54, 81] as const;
const LOGO_E_INDEX = 1;
const LOGO_EXPAND_DELAYS = [0.24, 0.1, 0.19, 0.28] as const;
const LOGO_COLLAPSE_DELAYS = [0.02, 0.18, 0.1, 0.16] as const;
const LOGO_COLLAPSE_TIMES = [0, 0.52, 1] as const;

/**
 * Sidebar logo morph built from the two official brand assets.
 *
 * The full lockup is clipped into its four original keycap tiles. On
 * collapse a/z/a travel into the shared é tile and disappear; only then
 * does the official compact é symbol grow to rail size. On expand the
 * symbol first shrinks into the é slot, after which the other tiles are
 * born back out of it. No letterforms are redrawn or replaced by a font.
 */
export function AnimatedAezaLogo({ collapsed }: { collapsed: boolean }) {
  return (
    <motion.span
      className="aeza-logo-animated"
      initial={false}
      animate={{ width: collapsed ? 46 : 106 }}
      transition={springGentle}
      aria-hidden="true"
    >
      <motion.span
        className="aeza-logo-compact-layer"
        initial={false}
        animate={{
          opacity: collapsed ? 1 : 0,
          scale: collapsed ? 1 : 0.58,
          x: collapsed ? 0 : 17,
        }}
        transition={
          collapsed
            ? { duration: 0.52, delay: 0.3, ease: [0.22, 0.78, 0.24, 1] }
            : { ...springGentle, delay: 0 }
        }
      >
        <img src="/static/brand/aeza-symbol.svg" alt="" draggable={false} />
      </motion.span>
      <motion.span
        className="aeza-logo-slices"
        initial={false}
        animate={{ x: collapsed ? -17 : 0 }}
        transition={
          collapsed
            ? { duration: 0.68, ease: [0.22, 0.78, 0.24, 1] }
            : springGentle
        }
      >
        {LOGO_TILE_OFFSETS.map((offset, index) => (
          <motion.span
            key={offset}
            className="aeza-logo-slice"
            initial={false}
            animate={{
              x: collapsed
                ? [
                    offset,
                    offset + (LOGO_TILE_OFFSETS[LOGO_E_INDEX] - offset) * 0.56,
                    LOGO_TILE_OFFSETS[LOGO_E_INDEX],
                  ]
                : offset,
              scale: collapsed
                ? index === LOGO_E_INDEX
                  ? [1, 1.06, 1.24]
                  : [1, 0.82, 0.18]
                : 1,
              opacity: collapsed ? [1, 1, 0] : 1,
            }}
            transition={
              collapsed
                ? {
                    duration: 0.68,
                    times: [...LOGO_COLLAPSE_TIMES],
                    ease: [0.22, 0.78, 0.24, 1],
                    delay: LOGO_COLLAPSE_DELAYS[index],
                  }
                : {
                    ...springGentle,
                    delay: LOGO_EXPAND_DELAYS[index],
                  }
            }
          >
            <img
              src="/static/brand/aeza-logo.svg"
              alt=""
              draggable={false}
              style={{ transform: `translateX(${-offset}px)` }}
            />
          </motion.span>
        ))}
      </motion.span>
    </motion.span>
  );
}

/** Aéza pattern from the guidebook: three straight parallel lines and one
 * accent line that changes direction through a soft rounded turn. */
export function BrandPattern({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`brand-pattern ${className}`.trim()}
      viewBox="0 0 360 140"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <path className="brand-pattern-line" d="M-10 92H370" />
      <path className="brand-pattern-line" d="M-10 108H370" />
      <path className="brand-pattern-line" d="M-10 124H370" />
      <path className="brand-pattern-accent" d="M-10 48H214Q258 48 258 4V-10" />
      <path className="brand-pattern-echo" d="M370 66H300Q256 66 256 110V150" />
    </svg>
  );
}

export type MascotPose = "business" | "calm";

export function MascotImage({
  pose = "business",
  className = "",
}: {
  pose?: MascotPose;
  className?: string;
}) {
  return (
    <img
      className={`mascot-image mascot-${pose} ${className}`.trim()}
      src={`/static/brand/aeza-mascot-${pose}.webp`}
      alt="Aéza-тян, маскот Aéza"
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}

interface MascotTipProps {
  storageKey: string;
  eyebrow?: string;
  title: string;
  children: ReactNode;
  pose?: MascotPose;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

export function MascotTip({
  storageKey,
  eyebrow = "Aéza-тян подсказывает",
  title,
  children,
  pose = "calm",
  actionLabel,
  onAction,
  className = "",
}: MascotTipProps) {
  const [visible, setVisible] = useState(() => {
    try {
      return window.localStorage.getItem(`kontur:mascot-tip:${storageKey}`) !== "1";
    } catch {
      return true;
    }
  });
  if (!visible) return null;
  const dismiss = () => {
    setVisible(false);
    try {
      window.localStorage.setItem(`kontur:mascot-tip:${storageKey}`, "1");
    } catch {
      /* Private browsing may reject storage; the tip is still closed. */
    }
  };
  return (
    <aside className={`mascot-tip ${className}`.trim()} aria-label={`${title}`}>
      <span className="mascot-tip-figure" aria-hidden="true">
        <MascotImage pose={pose} />
      </span>
      <div className="mascot-tip-copy">
        <span>{eyebrow}</span>
        <strong>{title}</strong>
        <div>{children}</div>
        {actionLabel && onAction ? (
          <button type="button" className="mascot-tip-action" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="mascot-tip-close"
        onClick={dismiss}
        aria-label="Скрыть подсказку Aéza-тян"
      >
        ×
      </button>
    </aside>
  );
}

interface MascotStageProps {
  eyebrow: string;
  title: string;
  text: string;
  pose?: MascotPose;
  actionLabel?: string;
  onAction?: () => void;
}

export function MascotStage({
  eyebrow,
  title,
  text,
  pose = "business",
  actionLabel,
  onAction,
}: MascotStageProps) {
  return (
    <motion.aside
      className="mascot-stage"
      initial={{ opacity: 0, y: 18, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ ...springEmphasized, delay: 0.12 }}
      aria-label={`${title}. ${text}`}
    >
      <div className="mascot-stage-copy">
        <span className="eyebrow mascot-eyebrow">{eyebrow}</span>
        <strong>{title}</strong>
        <span>{text}</span>
        {actionLabel && onAction ? (
          <md-filled-button class="mascot-action" onClick={onAction}>
            {actionLabel}
          </md-filled-button>
        ) : null}
      </div>
      {/* Portrait cookie-blob media frame (M3 Expressive): the
          expressive shape wraps the mascot only, never the text, and
          morphs to cookie-alt on stage hover. The idle float is a CSS
          transform animation (compositor), not a JS rAF loop. */}
      <div className="mascot-stage-figure" aria-hidden="true">
        <BrandPattern className="mascot-stage-pattern" />
        <MascotImage pose={pose} />
      </div>
    </motion.aside>
  );
}

/** MD3 Expressive loading motif: keycap tiles morph through cookie/clover
 * radii while only transform/opacity do the travelling. */
export function ShapeLoader({ label = "Загружаем данные" }: { label?: string }) {
  return (
    <span className="shape-loader" role="status" aria-label={label}>
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </span>
  );
}
