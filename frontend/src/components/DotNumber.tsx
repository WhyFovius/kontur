import { useEffect, useMemo, useState } from "react";
import { useMotionValue, useReducedMotion, useSpring } from "framer-motion";
import { integer, money } from "../format";

/* Classic 5×7 dot-matrix glyphs (rows of bits) for the digits we need. */
const GLYPHS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  "3": ["01110", "10001", "00001", "00110", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "€": ["01110", "10001", "11111", "10000", "11111", "10001", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  ",": ["00000", "00000", "00000", "00000", "01100", "00100", "01000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  " ": ["000", "000", "000", "000", "000", "000", "000"],
};

function formatEuro(cents: number): string {
  const euros = Math.round(cents / 100);
  if (Math.abs(euros) >= 100_000) {
    return `€${(euros / 1000).toFixed(1)}K`;
  }
  return `€${integer(euros)}`.replace(/\s/g, " ");
}

/**
 * Dot-matrix count-up number — the signature visual of the finance
 * bento the user shared, rebuilt natively: the amount is drawn as a
 * 5×7 dot grid per character and counted up with a spring. The real
 * value stays available to assistive tech via the aria-label.
 */
export function DotNumber({ value, pitch = 5 }: { value: number; pitch?: number }) {
  const reduced = useReducedMotion();
  const mv = useMotionValue(reduced ? value : 0);
  // Critically damped, settles in ~0.6s: the old 55/20 spring crawled
  // for two seconds and the matrix sat mid-morph in screenshots.
  const spring = useSpring(mv, { stiffness: 170, damping: 26 });
  const [text, setText] = useState(() => formatEuro(reduced ? value : 0));

  useEffect(() => {
    mv.set(value);
  }, [mv, value]);

  useEffect(
    () =>
      spring.on("change", (v) => {
        const next = formatEuro(v);
        setText((prev) => (prev === next ? prev : next));
      }),
    [spring],
  );

  const { circles, width } = useMemo(() => {
    const layout = (str: string) => {
      const on = new Set<string>();
      let x = 0;
      for (const ch of str) {
        const glyph = GLYPHS[ch] ?? GLYPHS[" "];
        const w = glyph[0].length;
        for (let r = 0; r < 7; r++) {
          for (let k = 0; k < w; k++) {
            if (glyph[r][k] === "1") on.add(`${x + k}:${r}`);
          }
        }
        x += w + 1;
      }
      return { on, cols: Math.max(1, x - 1) };
    };
    const { on, cols } = layout(text);
    // Reserve the final value's width from the first frame so the count
    // never makes the panel jump sideways as digits are added.
    const usedCols = Math.max(cols, layout(formatEuro(value)).cols);
    const nodes: React.ReactNode[] = [];
    for (let c = 0; c < usedCols; c++) {
      for (let r = 0; r < 7; r++) {
        const lit = on.has(`${c}:${r}`);
        nodes.push(
          <circle
            key={`${c}-${r}`}
            cx={c * pitch + pitch / 2}
            cy={r * pitch + pitch / 2}
            r={pitch * 0.36}
            fill="currentColor"
            opacity={lit ? 1 : 0.09}
            style={{
              transform: lit ? "none" : "scale(0.55)",
              transformBox: "fill-box",
              transformOrigin: "center",
              transition: "opacity .26s ease, transform .26s ease",
              transitionDelay: `${c * 7}ms`,
            }}
          />,
        );
      }
    }
    return { circles: nodes, width: usedCols * pitch };
  }, [text, pitch, value]);

  return (
    <span role="img" aria-label={money(value)} className="dot-number">
      <svg
        width={width}
        height={7 * pitch}
        viewBox={`0 0 ${width} ${7 * pitch}`}
        aria-hidden="true"
      >
        {circles}
      </svg>
    </span>
  );
}
