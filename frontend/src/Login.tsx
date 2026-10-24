import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion, useAnimationControls } from "framer-motion";
import { useTheme } from "./theme";
import { springEmphasized, springSnappy } from "./motion";
import { ThemeToggle } from "./components/Chrome";
import { IconArrowUpRight, IconCheck, IconLock } from "./icons";

type Phase = "idle" | "loading" | "success";

const lineReveal = {
  hidden: { y: "110%" },
  show: (delay: number) => ({
    y: "0%",
    transition: { ...springEmphasized, delay },
  }),
};

export function Login() {
  const { theme, toggleTheme } = useTheme();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const submitLock = useRef(false);
  const shake = useAnimationControls();

  useEffect(() => {
    document.title = "Вход · Контур аналитики";
    if (new URLSearchParams(window.location.search).has("expired")) {
      setError("Сессия завершилась. Войдите снова.");
    }
    // The form's `animate` is bound to the shake controls, so the entrance
    // must be driven through the same controls (whileInView would be ignored).
    void shake.start({
      opacity: 1,
      y: 0,
      scale: 1,
      transition: springEmphasized,
    });
    return () => {
      document.title = "Контур — удержание клиентов";
    };
  }, [shake]);

  const fail = (message: string, credentials: boolean) => {
    setError(message);
    setInvalid(credentials);
    void shake.start({
      x: [0, -12, 11, -7, 6, -2, 0],
      transition: { duration: 0.45, ease: "easeInOut" },
    });
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (phase !== "idle" || submitLock.current) return;
    if (!username.trim() || !password) {
      fail("Введите логин и пароль.", true);
      return;
    }
    setError(null);
    setInvalid(false);
    submitLock.current = true;
    setPhase("loading");
    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const payload = (await response.json().catch(() => ({}))) as { detail?: string };
      if (!response.ok) {
        submitLock.current = false;
        setPhase("idle");
        fail(payload.detail || "Не удалось войти. Проверьте логин и пароль.", true);
        document.getElementById("password")?.focus();
        return;
      }
      setPhase("success");
      window.setTimeout(() => window.location.replace("/"), 520);
    } catch {
      submitLock.current = false;
      setPhase("idle");
      fail("Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.", false);
    }
  };

  return (
    <div className="login-shell">
      <ThemeToggle theme={theme} onToggle={toggleTheme} className="login-theme-toggle" />

      <section className="login-hero-panel" aria-labelledby="brandTitle">
        <motion.div
          className="login-orb login-orb-one"
          aria-hidden="true"
          animate={{ y: [0, -16, 0], x: [0, 10, 0] }}
          transition={{ repeat: Infinity, duration: 11, ease: "easeInOut" }}
        />
        <motion.div
          className="login-orb login-orb-two"
          aria-hidden="true"
          animate={{ y: [0, 14, 0], x: [0, -12, 0] }}
          transition={{ repeat: Infinity, duration: 13, ease: "easeInOut", delay: 1.2 }}
        />

        <a className="brand-lockup brand-lockup-invert" href="/login" aria-label="Контур аналитики">
          <span className="brand-mark" aria-hidden="true">
            <span style={{ transform: "scaleY(.45)" }} />
            <span style={{ transform: "scaleY(.8)" }} />
            <span />
          </span>
          <span className="brand-name">
            контур <span>/ удержание</span>
          </span>
        </a>

        <div className="login-hero-copy">
          <motion.span
            className="eyebrow eyebrow-invert"
            initial={{ opacity: 0, x: -14 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...springEmphasized, delay: 0.05 }}
          >
            <span className="eyebrow-line" aria-hidden="true" />
            Аналитика удержания
          </motion.span>
          <h1 id="brandTitle">
            <span className="line-mask">
              <motion.span variants={lineReveal} custom={0.12} initial="hidden" animate="show">
                Заметить риск.
              </motion.span>
            </span>
            <span className="line-mask">
              <motion.span
                className="login-accent-line"
                variants={lineReveal}
                custom={0.22}
                initial="hidden"
                animate="show"
              >
                Удержать клиента.
              </motion.span>
            </span>
          </h1>
          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...springEmphasized, delay: 0.34 }}
          >
            Приоритеты команды, понятные причины оттока и выручка под угрозой — в одном
            рабочем пространстве, которое пересчитывается при каждом изменении модели.
          </motion.p>
        </div>

        <motion.div
          className="login-visual"
          aria-hidden="true"
          initial={{ opacity: 0, y: 28, rotate: -1.5 }}
          animate={{ opacity: 1, y: 0, rotate: 0 }}
          transition={{ ...springEmphasized, delay: 0.42 }}
        >
          <motion.div
            className="mock-card"
            animate={{ y: [0, -7, 0] }}
            transition={{ repeat: Infinity, duration: 7, ease: "easeInOut" }}
          >
            <div className="mock-card-head">
              <span className="mock-dot mock-dot-high" />
              <span className="mock-line mock-line-mid" />
              <span className="mock-pill" />
            </div>
            <div className="mock-bars">
              {[0.5, 0.85, 0.62, 1, 0.72].map((height, index) => (
                <motion.span
                  key={index}
                  initial={{ scaleY: 0 }}
                  animate={{ scaleY: height }}
                  transition={{ ...springEmphasized, delay: 0.6 + index * 0.08 }}
                />
              ))}
            </div>
            <span className="mock-line" />
            <span className="mock-line mock-line-short" />
          </motion.div>
          <motion.span
            className="mock-chip mock-chip-one"
            animate={{ y: [0, -9, 0], rotate: [0, -2, 0] }}
            transition={{ repeat: Infinity, duration: 8, ease: "easeInOut", delay: 0.6 }}
          >
            Скорое окончание услуги
          </motion.span>
          <motion.span
            className="mock-chip mock-chip-two"
            animate={{ y: [0, 8, 0], rotate: [0, 2, 0] }}
            transition={{ repeat: Infinity, duration: 9, ease: "easeInOut", delay: 1.4 }}
          >
            Не хватает средств на продление
          </motion.span>
        </motion.div>

        <motion.div
          className="login-note"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.7, duration: 0.5 }}
        >
          <span className="note-signal" aria-hidden="true" />
          <span>Модель пересчитывается при обновлении снимка</span>
        </motion.div>
      </section>

      <section className="login-form-panel" aria-labelledby="loginTitle">
        <motion.form
          className="login-form"
          onSubmit={onSubmit}
          noValidate
          animate={shake}
          initial={{ opacity: 0, y: 24, scale: 0.985 }}
        >
          <div className="form-heading">
            <span className="eyebrow">Рабочее пространство</span>
            <h2 id="loginTitle">Войти в Контур</h2>
            <p>Используйте учётные данные администратора.</p>
          </div>

          <div className="field">
            <input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              spellCheck={false}
              required
              maxLength={128}
              placeholder=" "
              value={username}
              aria-invalid={invalid || undefined}
              aria-describedby={error ? "loginError" : undefined}
              onChange={(event) => {
                setUsername(event.target.value);
                setInvalid(false);
                setError(null);
              }}
            />
            <label htmlFor="username">Логин</label>
          </div>

          <div className="field">
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              placeholder=" "
              value={password}
              aria-invalid={invalid || undefined}
              aria-describedby={error ? "loginError" : undefined}
              onChange={(event) => {
                setPassword(event.target.value);
                setInvalid(false);
                setError(null);
              }}
            />
            <label htmlFor="password">Пароль</label>
          </div>

          <AnimatePresence initial={false}>
            {error && (
              <motion.p
                id="loginError"
                className="form-error"
                role="alert"
                aria-live="assertive"
                initial={{ height: 0, opacity: 0, y: -4 }}
                animate={{ height: "auto", opacity: 1, y: 0 }}
                exit={{ height: 0, opacity: 0, y: -4 }}
                transition={springSnappy}
              >
                <span>{error}</span>
              </motion.p>
            )}
          </AnimatePresence>

          {/* Material Web filled button. The onClick requestSubmit is a
              belt-and-suspenders fallback in case form association is
              unavailable; submitLock in onSubmit prevents any double
              submission if both paths fire. */}
          <md-filled-button
            class="login-submit-md"
            type="submit"
            trailingIcon={phase === "idle"}
            disabled={phase !== "idle"}
            onClick={(event: React.MouseEvent<HTMLElement>) => {
              event.currentTarget.closest("form")?.requestSubmit();
            }}
          >
            {phase === "success" ? (
              <>
                <span slot="icon" className="md-icon-wrap">
                  <IconCheck />
                </span>
                Добро пожаловать
              </>
            ) : phase === "loading" ? (
              <>
                <md-circular-progress indeterminate class="login-progress" />
                Проверяем данные…
              </>
            ) : (
              <>
                Войти в панель
                <span slot="icon" className="md-icon-wrap">
                  <IconArrowUpRight />
                </span>
              </>
            )}
          </md-filled-button>

          <p className="login-footnote">
            <IconLock /> Сессия хранится в защищённой cookie
          </p>
        </motion.form>
        <footer className="login-footer">
          <span>Контур · Аналитика удержания</span>
          <span>Доступ по приглашению</span>
        </footer>
      </section>
    </div>
  );
}
