import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";

export type GlassTone = "clear" | "soft" | "tinted" | "dark";
export type GlassIntensity = "subtle" | "regular" | "strong";
export type GlassRadius = "small" | "medium" | "large" | "pill";

export interface LiquidGlassProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
  /** Material depth. `regular` is the balanced default. */
  intensity?: GlassIntensity;
  /** Adaptive tint sampled from the theme; `clear` preserves background colour. */
  tone?: GlassTone;
  radius?: GlassRadius;
  /** Adds a restrained pointer reflection on capable desktop pointers. */
  interactive?: boolean;
  /** Enables the SVG edge-displacement layer. Disabled automatically in reduced-motion mode. */
  refractive?: boolean;
  as?: "div" | "section" | "aside" | "article" | "header" | "nav";
}

type GlassCssVars = CSSProperties & {
  "--glass-pointer-x"?: string;
  "--glass-pointer-y"?: string;
  "--glass-pointer-opacity"?: string;
  "--glass-edge-opacity"?: string;
};

const GLASS_REFLECTION_SVG_ID = "kontur-liquid-glass-refraction";

/**
 * One shared displacement map for every glass surface. The map bends the
 * backdrop only near the rim, imitating the thicker edge of a physical
 * lens while keeping the centre readable.
 */
export function LiquidGlassDefs() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="liquid-glass-defs"
      width="0"
      height="0"
    >
      <defs>
        <filter
          id={GLASS_REFLECTION_SVG_ID}
          x="-8%"
          y="-8%"
          width="116%"
          height="116%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur in="SourceAlpha" stdDeviation="9" result="soft-alpha" />
          <feOffset in="soft-alpha" dx="0" dy="5" result="offset-alpha" />
          <feComposite in="offset-alpha" in2="SourceAlpha" operator="out" result="edge-alpha" />
          <feGaussianBlur in="edge-alpha" stdDeviation="3.5" result="soft-edge" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="soft-edge"
            scale="15"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  );
}

function supportsBackdropFilter(): boolean {
  if (typeof window === "undefined") return false;
  return (
    "CSS" in window &&
    (CSS.supports("backdrop-filter", "blur(1px)") ||
      CSS.supports("-webkit-backdrop-filter", "blur(1px)"))
  );
}

/**
 * Reusable optical material for the whole application.
 *
 * Rendering is deliberately layered:
 *  1. adaptive translucent base + controlled saturation/blur;
 *  2. a very subtle chromatic edge tint;
 *  3. a shared, low-resolution SVG displacement filter for rim refraction;
 *  4. directional specular and inner edge highlights;
 *  5. a pointer reflection that is written to CSS variables without causing
 *     React renders.
 *
 * No WebGL context is created: the current interface gains more from a few
 * inexpensive composited layers than from a continuously rendered canvas.
 */
export const LiquidGlass = forwardRef<HTMLDivElement, LiquidGlassProps>(
  function LiquidGlass(
    {
      children,
      className = "",
      intensity = "regular",
      tone = "clear",
      radius = "medium",
      interactive = false,
      refractive = true,
      as: Component = "div",
      style,
      ...rest
    },
    ref,
  ) {
    const elementRef = useRef<HTMLDivElement | null>(null);
    const frameRef = useRef<number | null>(null);
    const pointerInside = useRef(false);
    const supportsFilters = useRef<boolean | null>(null);

    useEffect(() => {
      supportsFilters.current = supportsBackdropFilter();
      const element = elementRef.current;
      if (!element || !interactive) return undefined;

      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
      const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

      const writePointer = (clientX: number, clientY: number) => {
        if (frameRef.current !== null) return;
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          if (!pointerInside.current) return;
          const bounds = element.getBoundingClientRect();
          const x = clientX - bounds.left;
          const y = clientY - bounds.top;
          element.style.setProperty("--glass-pointer-x", `${x}px`);
          element.style.setProperty("--glass-pointer-y", `${y}px`);
          element.style.setProperty("--glass-pointer-opacity", "1");
        });
      };

      const onPointerMove = (event: PointerEvent) => {
        if (event.pointerType !== "mouse") return;
        pointerInside.current = true;
        writePointer(event.clientX, event.clientY);
      };
      const onPointerLeave = () => {
        pointerInside.current = false;
        element.style.setProperty("--glass-pointer-opacity", "0");
      };
      const onPointerEnter = (event: PointerEvent) => {
        if (event.pointerType !== "mouse") return;
        pointerInside.current = true;
      };

      const onPointerChange = () => {
        if (reduced.matches || !finePointer.matches) {
          pointerInside.current = false;
          element.style.setProperty("--glass-pointer-opacity", "0");
        }
      };

      element.addEventListener("pointermove", onPointerMove, { passive: true });
      element.addEventListener("pointerenter", onPointerEnter, { passive: true });
      element.addEventListener("pointerleave", onPointerLeave, { passive: true });
      reduced.addEventListener("change", onPointerChange);
      finePointer.addEventListener("change", onPointerChange);

      return () => {
        element.removeEventListener("pointermove", onPointerMove);
        element.removeEventListener("pointerenter", onPointerEnter);
        element.removeEventListener("pointerleave", onPointerLeave);
        reduced.removeEventListener("change", onPointerChange);
        finePointer.removeEventListener("change", onPointerChange);
        if (frameRef.current !== null) {
          window.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
      };
    }, [interactive]);

    const mergeRef = useCallback(
      (node: HTMLDivElement | null) => {
        elementRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    const cssVars: GlassCssVars = {
      ...(style as GlassCssVars),
      "--glass-pointer-x": "50%",
      "--glass-pointer-y": "50%",
      "--glass-pointer-opacity": "0",
    };

    const classes = [
      "liquid-glass",
      `liquid-glass--${intensity}`,
      `liquid-glass--${tone}`,
      `liquid-glass--radius-${radius}`,
      interactive ? "liquid-glass--interactive" : "",
      refractive ? "liquid-glass--refractive" : "",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <Component
        {...rest}
        ref={mergeRef}
        className={classes}
        style={cssVars}
        data-liquid-glass="true"
      >
        <span className="liquid-glass__refraction" aria-hidden="true" />
        <span className="liquid-glass__tint" aria-hidden="true" />
        <span className="liquid-glass__pointer" aria-hidden="true" />
        <span className="liquid-glass__edge" aria-hidden="true" />
        <span className="liquid-glass__shine" aria-hidden="true" />
        <span className="liquid-glass__content">{children}</span>
      </Component>
    );
  },
);

export interface GlassButtonProps
  extends Omit<HTMLAttributes<HTMLButtonElement>, "children"> {
  children?: ReactNode;
  variant?: "primary" | "tonal" | "plain";
  size?: "small" | "medium" | "large";
  iconOnly?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  type?: "button" | "submit" | "reset";
}

export function GlassButton({
  children,
  className = "",
  variant = "tonal",
  size = "medium",
  iconOnly = false,
  leading,
  trailing,
  type = "button",
  ...rest
}: GlassButtonProps) {
  return (
    <LiquidGlass
      as="div"
      intensity={variant === "primary" ? "strong" : "subtle"}
      tone={variant === "primary" ? "tinted" : "clear"}
      radius="pill"
      className={`glass-button-shell glass-button-shell--${variant} glass-button-shell--${size}${iconOnly ? " glass-button-shell--icon" : ""} ${className}`.trim()}
    >
      <button {...rest} type={type} className="glass-button">
        {leading ? <span className="glass-button__leading">{leading}</span> : null}
        {children ? <span className="glass-button__label">{children}</span> : null}
        {trailing ? <span className="glass-button__trailing">{trailing}</span> : null}
      </button>
    </LiquidGlass>
  );
}

export interface GlassIconButtonProps
  extends Omit<HTMLAttributes<HTMLButtonElement>, "children" | "type"> {
  children?: ReactNode;
  label: string;
  size?: "small" | "medium";
  tone?: "clear" | "dark";
  type?: "button" | "submit" | "reset";
}

export function GlassIconButton({
  children,
  className = "",
  label,
  size = "medium",
  tone = "clear",
  type = "button",
  ...rest
}: GlassIconButtonProps) {
  return (
    <LiquidGlass
      as="div"
      intensity="subtle"
      tone={tone}
      radius="pill"
      interactive
      className={`glass-icon-button-shell glass-icon-button-shell--${size} ${className}`.trim()}
    >
      <button {...rest} type={type} className="glass-icon-button" aria-label={label} title={label}>
        {children}
      </button>
    </LiquidGlass>
  );
}
