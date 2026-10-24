import { useEffect, useRef } from "react";
import { useMotionValue, useSpring, useReducedMotion } from "framer-motion";

interface AnimatedNumberProps {
  value: number;
  format: (value: number) => string;
  className?: string;
  /** Screen-reader label; animated digits themselves are decorative. */
  label?: string;
}

/**
 * Spring-tweened number. KPI digits physically "flow" to the new value
 * after a weight change or snapshot refresh instead of snapping.
 * Writes straight to the DOM node — no re-render per frame.
 */
export function AnimatedNumber({ value, format, className, label }: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduceMotion = useReducedMotion();
  const motionValue = useMotionValue(0);
  const spring = useSpring(motionValue, { stiffness: 120, damping: 24, mass: 0.9 });
  const firstRender = useRef(true);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (reduceMotion) {
      node.textContent = format(value);
      motionValue.set(value);
      return;
    }
    const unsubscribe = spring.on("change", (latest) => {
      if (ref.current) ref.current.textContent = format(Math.round(latest));
    });
    if (firstRender.current) {
      // Count up from zero on first paint — the commercial "hero metric" moment.
      firstRender.current = false;
      motionValue.set(0);
      requestAnimationFrame(() => motionValue.set(value));
    } else {
      motionValue.set(value);
    }
    return unsubscribe;
  }, [value, format, motionValue, spring, reduceMotion]);

  return (
    <span className={className}>
      <span ref={ref} aria-hidden="true">
        {format(reduceMotion ? value : 0)}
      </span>
      <span className="sr-only">{label ?? format(value)}</span>
    </span>
  );
}
