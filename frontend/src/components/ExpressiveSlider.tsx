import { useEffect, useState } from "react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
} from "framer-motion";
import { springStdFastSpatial } from "../motion";

interface ExpressiveSliderProps {
  id: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  onChange: (value: number) => void;
  formatValue?: (value: number) => string;
  dataWeight?: string;
}

const STOPS = [0, 25, 50, 75, 100];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Kontur's M3 Expressive slider.
 *
 * Material Web has no Expressive slider implementation, and its standard
 * slider could leave the handle visually detached from the current model
 * value. This component therefore keeps a real native range input for
 * keyboard, touch, form and assistive-technology semantics, while the
 * visible wavy track, morphing handle and permanent value bubble are custom.
 *
 * Motion is deliberately cheap and refresh-rate independent: one motion
 * value is spring-integrated from wall-clock time; the handle moves with a
 * transform and the active wave is revealed with clip-path. The business
 * value itself changes immediately from the native input event.
 */
export function ExpressiveSlider({
  id,
  value,
  min = 0,
  max = 100,
  step = 1,
  label,
  onChange,
  formatValue = (next) => String(next),
  dataWeight,
}: ExpressiveSliderProps) {
  const safeValue = clamp(Number.isFinite(value) ? value : min, min, max);
  const percent = max === min ? 0 : ((safeValue - min) / (max - min)) * 100;
  const reduceMotion = useReducedMotion();
  const [dragging, setDragging] = useState(false);

  const target = useMotionValue(percent);
  const displayPercent = useSpring(target, {
    stiffness: springStdFastSpatial.stiffness,
    damping: springStdFastSpatial.damping,
    mass: springStdFastSpatial.mass,
  });
  const handleX = useTransform(displayPercent, (next) => `${next}%`);
  const activeClip = useTransform(
    displayPercent,
    (next) => `inset(0 ${100 - clamp(next, 0, 100)}% 0 0 round 999px)`,
  );

  useEffect(() => {
    if (reduceMotion) displayPercent.jump(percent);
    target.set(percent);
  }, [displayPercent, percent, reduceMotion, target]);

  const edge = percent <= 9 ? "start" : percent >= 91 ? "end" : "center";
  const formatted = formatValue(safeValue);

  return (
    <div
      className="expressive-slider"
      data-dragging={dragging || undefined}
      data-value-edge={edge}
    >
      <div className="expressive-slider-rail" aria-hidden="true">
        <span className="expressive-slider-track expressive-slider-track-inactive" />
        <motion.span
          className="expressive-slider-track expressive-slider-track-active"
          style={{ clipPath: activeClip }}
        />
        <span className="expressive-slider-stops">
          {STOPS.map((stop) => (
            <i
              key={stop}
              className={percent >= stop ? "is-reached" : undefined}
              style={{ left: `${stop}%` }}
            />
          ))}
        </span>
        <motion.span className="expressive-slider-flight" style={{ x: handleX }}>
          <output className="expressive-slider-value" htmlFor={id}>
            {formatted}
          </output>
          <span className="expressive-slider-handle">
            <i />
            <i />
            <i />
          </span>
        </motion.span>
      </div>

      <input
        id={id}
        className="expressive-slider-input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={safeValue}
        data-weight={dataWeight}
        aria-label={label}
        aria-valuetext={formatted}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (!Number.isFinite(next)) return;
          target.set(max === min ? 0 : ((next - min) / (max - min)) * 100);
          onChange(next);
        }}
        onPointerDown={(event) => {
          setDragging(true);
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onLostPointerCapture={() => setDragging(false)}
        onBlur={() => setDragging(false)}
      />
    </div>
  );
}
