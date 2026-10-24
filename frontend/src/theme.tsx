import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

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

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

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
