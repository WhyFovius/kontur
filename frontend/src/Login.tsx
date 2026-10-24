import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion, useAnimationControls } from "framer-motion";
import { useTheme } from "./theme";
import { springEmphasized, springSnappy } from "./motion";
import { ThemeToggle } from "./components/Chrome";
import { AezaLogo, BrandPattern, MascotImage } from "./components/Brand";
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
  const [oidc, setOidc] = useState<{ name: string; loginUrl: string } | null>(null);
  const submitLock = useRef(false);
  const shake = useAnimationControls();

  useEffect(() => {
    document.title = "Вход · Aéza Контур";
    const params = new URLSearchParams(window.location.search);
    if (params.has("expired")) {
      setError("Сессия завершилась. Войдите снова.");
    }
    if (params.has("oidc_error")) {
      setError("Не удалось войти через SSO. Попробуйте ещё раз или используйте пароль.");
    }
    // Offer the SSO button only when an OIDC provider is configured;
    // the password form stays as the fallback either way.
    fetch("/api/v1/auth/providers", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        const provider = payload?.oidc;
        if (provider?.enabled && provider.loginUrl) {
          setOidc({
            name: provider.name || "SSO",
            loginUrl: provider.loginUrl,
          });
        }
      })
      .catch(() => undefined);
    // The form's `animate` is bound to the shake controls, so the entrance
    // must be driven through the same controls (whileInView would be ignored).
    void shake.start({
      opacity: 1,
      y: 0,
      scale: 1,
      transition: springEmphasized,
    });
    return () => {
      document.title = "Aéza Контур — удержание клиентов";
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
        <BrandPattern className="login-pattern" />
        <div className="login-orb login-orb-one float-loop" aria-hidden="true" />
        <div className="login-orb login-orb-two float-loop" aria-hidden="true" />

        <a className="brand-lockup login-brand-lockup" href="/login" aria-label="Aéza Контур">
          <span className="brand-logo-full">
            <AezaLogo />
          </span>
          <span className="brand-product">
            <strong>Контур</strong>
            <small>удержание клиентов</small>
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
          <div className="mock-card float-loop">
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
          </div>
          <div className="login-mascot-card float-loop">
            <BrandPattern />
            <MascotImage pose="business" />
            <span>Aéza-тян</span>
          </div>
          <span className="mock-chip mock-chip-one float-loop">
            Скорое окончание услуги
          </span>
          <span className="mock-chip mock-chip-two float-loop">
            Не хватает средств на продление
          </span>
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
            <h2 id="loginTitle">Войти в Aéza Контур</h2>
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

          {oidc && (
            <>
              <div className="login-divider" aria-hidden="true">
                <span>или</span>
              </div>
              <md-outlined-button class="login-sso" href={oidc.loginUrl}>
                <span slot="icon" className="md-icon-wrap">
                  <IconLock />
                </span>
                Войти через {oidc.name}
              </md-outlined-button>
            </>
          )}

          <p className="login-footnote">
            <IconLock /> Сессия хранится в защищённой cookie
          </p>
        </motion.form>
        <footer className="login-footer">
          <span>Aéza · Контур удержания</span>
          <span>Доступ по приглашению</span>
        </footer>
      </section>
    </div>
  );
}
