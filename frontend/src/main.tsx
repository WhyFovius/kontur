import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import "./material";
import { Dashboard } from "./Dashboard";
import { Login } from "./Login";
import "./styles/tokens.css";
import "./styles/dashboard.css";
import "./styles/login.css";

// FastAPI keeps the server-side auth gate: "/" is only served to a signed-in
// session and "/login" only to anonymous visitors, so routing by pathname
// here simply picks the matching experience.
const isLogin = window.location.pathname === "/login";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      {isLogin ? <Login /> : <Dashboard />}
    </MotionConfig>
  </StrictMode>,
);
