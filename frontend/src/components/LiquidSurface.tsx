import { useEffect, useRef, useState, type ReactNode } from "react";

export interface LiquidSurfaceProps {
  children: ReactNode;
  /** Local intensity of the pointer-following light. */
  strength?: number;
  /** Disable the effect entirely (reduced motion, coarse pointer, data mode). */
  disabled?: boolean;
  className?: string;
}

/**
 * A very small, dependency-free pointer light.
 *
 * It writes CSS custom properties straight to the DOM inside a single
 * requestAnimationFrame, so moving the pointer never triggers a React
 * render. The light is intentionally small and low-contrast: it should
 * reveal the curvature of a glass surface, not act as a spotlight.
 */
export function LiquidSurface({
  children,
  strength = 1,
  disabled = false,
  className = "",
}: LiquidSurfaceProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const sync = () => setEnabled(!reduced.matches && finePointer.matches && !disabled);
    sync();
    reduced.addEventListener("change", sync);
    finePointer.addEventListener("change", sync);
    return () => {
      reduced.removeEventListener("change", sync);
      finePointer.removeEventListener("change", sync);
    };
  }, [disabled]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || !enabled) return undefined;

    const write = (clientX: number, clientY: number) => {
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        if (!activeRef.current) return;
        const bounds = element.getBoundingClientRect();
        const x = clientX - bounds.left;
        const y = clientY - bounds.top;
        element.style.setProperty("--liquid-light-x", `${x}px`);
        element.style.setProperty("--liquid-light-y", `${y}px`);
        element.style.setProperty("--liquid-light-opacity", "1");
      });
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      activeRef.current = true;
      write(event.clientX, event.clientY);
    };
    const onLeave = () => {
      activeRef.current = false;
      element.style.setProperty("--liquid-light-opacity", "0");
    };

    element.addEventListener("pointermove", onMove, { passive: true });
    element.addEventListener("pointerleave", onLeave, { passive: true });
    return () => {
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerleave", onLeave);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [enabled]);

  return (
    <div
      ref={elementRef}
      className={`liquid-surface ${className}`.trim()}
      data-liquid-surface={enabled ? "on" : "off"}
      style={{ "--liquid-light-strength": strength } as React.CSSProperties}
    >
      <span className="liquid-surface__light" aria-hidden="true" />
      <span className="liquid-surface__content">{children}</span>
    </div>
  );
}
