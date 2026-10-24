import { motion } from "framer-motion";
import { springEmphasized } from "../motion";

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
      {/* Portrait arch media frame: the expressive shape wraps the
          mascot only, never the text. The idle float is a CSS
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
