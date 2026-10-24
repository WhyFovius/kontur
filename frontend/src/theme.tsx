import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

export type Theme = "light" | "dark";

export interface ThemeToggleOrigin {
  x: number;
  y: number;
}

/** The icon morph in Chrome is timed to the same wave so the two read as
 * one gesture rather than two unrelated animations. */
export const THEME_WAVE_DURATION_MS = 720;

interface LocalViewTransition {
  ready: Promise<void>;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => LocalViewTransition;
};

function readInitialTheme(): Theme {
  if (typeof document !== "undefined") {
    const current = document.documentElement.dataset.theme;
    if (current === "dark" || current === "light") return current;
  }
  try {
    const saved = localStorage.getItem("churn-theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* storage may be unavailable */
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);

  const setTheme = useCallback((next: Theme, persist = true) => {
    document.documentElement.dataset.theme = next;
    setThemeState(next);
    if (persist) {
      try {
        localStorage.setItem("churn-theme", next);
      } catch {
        /* storage may be unavailable */
      }
    }
  }, []);

  const toggleTheme = useCallback(
    (origin?: ThemeToggleOrigin) => {
      const next: Theme = theme === "dark" ? "light" : "dark";
      const root = document.documentElement;
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const startViewTransition = (
        document as ViewTransitionDocument
      ).startViewTransition;

      if (!origin || reduceMotion || typeof startViewTransition !== "function") {
        setTheme(next);
        return;
      }

      const radius = Math.hypot(
        Math.max(origin.x, window.innerWidth - origin.x),
        Math.max(origin.y, window.innerHeight - origin.y),
      );

      try {
        const transition = startViewTransition.call(document, () => {
          flushSync(() => setTheme(next));
        });

        void transition.ready
          .then(() => {
            root.animate(
              {
                clipPath: [
                  `circle(0px at ${origin.x}px ${origin.y}px)`,
                  `circle(${radius}px at ${origin.x}px ${origin.y}px)`,
                ],
              },
              {
                duration: THEME_WAVE_DURATION_MS,
                easing: "cubic-bezier(0.2, 0, 0, 1)",
                pseudoElement: "::view-transition-new(root)",
              } as KeyframeAnimationOptions,
            );
          })
          .catch(() => {
            if (root.dataset.theme !== next) setTheme(next);
          });
      } catch {
        setTheme(next);
      }
    },
    [setTheme, theme],
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      try {
        if (!localStorage.getItem("churn-theme")) {
          setTheme(event.matches ? "dark" : "light", false);
        }
      } catch {
        /* keep current theme */
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [setTheme]);

  return { theme, setTheme, toggleTheme };
}
