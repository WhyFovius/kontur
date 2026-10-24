import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import "./material";
const Dashboard = lazy(() =>
  import("./Dashboard").then((m) => ({ default: m.Dashboard })),
);
import { Login } from "./Login";
import { LiquidGlassDefs } from "./components/LiquidGlass";
import "./styles/tokens.css";
import "./styles/liquid-glass.css";
import "./styles/liquid-surface.css";
import "./styles/dashboard.css";
import "./styles/liquid-glass-overrides.css";
import "./styles/liquid-glass-refraction.css";
import "./styles/liquid-glass-tuning.css";
import "./styles/login.css";
import "./styles/liquid-glass-live.css";

// FastAPI keeps the server-side auth gate: "/" is only served to a signed-in
// session and "/login" only to anonymous visitors, so routing by pathname
// here simply picks the matching experience.
const isLogin = window.location.pathname === "/login";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <LiquidGlassDefs />
      {isLogin ? (
        <Login />
      ) : (
        <Suspense fallback={<div className="app-loading" aria-label="Загружаем рабочее пространство" />}>
          <Dashboard />
        </Suspense>
      )}
    </MotionConfig>
  </StrictMode>,
);
