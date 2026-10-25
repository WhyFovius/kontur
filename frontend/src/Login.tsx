import { useEffect, useRef, useState, type FormEvent } from "react";
import { AnimatePresence, motion, useAnimationControls } from "framer-motion";
import { useTheme } from "./theme";
import { springEmphasized, springSnappy } from "./motion";
import { ThemeToggle } from "./components/Chrome";
import { AezaLogo, BrandPattern, MascotImage } from "./components/Brand";
import { IconArrowUpRight, IconCheck, IconClose, IconLock, IconShield } from "./icons";

type Phase = "idle" | "loading" | "success";
type AuthMode = "login" | "register";

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
  const [mode, setMode] = useState<AuthMode>("login");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [demoNoticeOpen, setDemoNoticeOpen] = useState(false);
  const [demoAccepted, setDemoAccepted] = useState(false);
  const demoCloseRef = useRef<HTMLButtonElement>(null);
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
        setRegistrationEnabled(Boolean(payload?.registration?.enabled));
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

  useEffect(() => {
    if (!demoNoticeOpen) return;
    demoCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDemoNoticeOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [demoNoticeOpen]);

  const switchMode = (nextMode: AuthMode) => {
    setMode(nextMode);
    setError(null);
    setInvalid(false);
    setPassword("");
    setConfirmPassword("");
    window.setTimeout(() => document.getElementById("username")?.focus(), 60);
  };

  const continueToRegistration = () => {
    if (!demoAccepted) return;
    setDemoNoticeOpen(false);
    switchMode("register");
  };

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
    const registering = mode === "register";
    if (!username.trim() || !password) {
      fail("Введите логин и пароль.", true);
      return;
    }
    if (registering) {
      if (!demoAccepted) {
        setDemoNoticeOpen(true);
        return;
      }
      if (username.trim().length < 3) {
        fail("Логин должен содержать не менее 3 символов.", true);
        return;
      }
      if (password.length < 8) {
        fail("Пароль должен содержать не менее 8 символов.", true);
        return;
      }
      if (password !== confirmPassword) {
        fail("Пароли не совпадают.", true);
        document.getElementById("confirmPassword")?.focus();
        return;
      }
    }
    setError(null);
    setInvalid(false);
    submitLock.current = true;
    setPhase("loading");
    try {
      const response = await fetch(
        registering ? "/api/v1/auth/register" : "/api/v1/auth/login",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            registering
              ? { username: username.trim(), password, demoAcknowledged: demoAccepted }
              : { username, password },
          ),
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        detail?: unknown;
      };
      if (!response.ok) {
        submitLock.current = false;
        setPhase("idle");
        const fallback = registering
          ? "Не удалось создать демо-аккаунт. Проверьте введённые данные."
          : "Не удалось войти. Проверьте логин и пароль.";
        fail(typeof payload.detail === "string" ? payload.detail : fallback, true);
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
            <span className="eyebrow">
              {mode === "register" ? "Демо-предпросмотр" : "Рабочее пространство"}
            </span>
            <h2 id="loginTitle">
              {mode === "register" ? "Создать демо-аккаунт" : "Войти в Aéza Контур"}
            </h2>
            <p>
              {mode === "register"
                ? "Откроется отдельная копия с уже внесёнными тестовыми данными."
                : "Используйте аккаунт администратора или созданный демо-аккаунт."}
            </p>
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
              autoComplete={mode === "register" ? "new-password" : "current-password"}
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

          {mode === "register" && (
            <div className="field">
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                maxLength={256}
                placeholder=" "
                value={confirmPassword}
                aria-invalid={invalid || undefined}
                aria-describedby={error ? "loginError" : undefined}
                onChange={(event) => {
                  setConfirmPassword(event.target.value);
                  setInvalid(false);
                  setError(null);
                }}
              />
              <label htmlFor="confirmPassword">Повторите пароль</label>
            </div>
          )}

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
                {mode === "register" ? "Создаём пространство…" : "Проверяем данные…"}
              </>
            ) : (
              <>
                {mode === "register" ? "Создать и войти" : "Войти в панель"}
                <span slot="icon" className="md-icon-wrap">
                  <IconArrowUpRight />
                </span>
              </>
            )}
          </md-filled-button>

          {mode === "login" && oidc && (
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

          {mode === "login" && registrationEnabled && (
            <>
              <div className="login-divider" aria-hidden="true">
                <span>нет аккаунта</span>
              </div>
              <button
                type="button"
                className="login-register-button"
                onClick={() => setDemoNoticeOpen(true)}
              >
                Создать демо-аккаунт
              </button>
            </>
          )}

          {mode === "register" && (
            <button
              type="button"
              className="login-mode-switch"
              onClick={() => switchMode("login")}
            >
              Уже есть аккаунт? Войти
            </button>
          )}

          <p className="login-footnote">
            <IconLock /> Сессия хранится в защищённой cookie
          </p>
        </motion.form>
        <footer className="login-footer">
          <span>Aéza · Контур удержания</span>
          <span>{registrationEnabled ? "Доступен демо-предпросмотр" : "Доступ по приглашению"}</span>
        </footer>
      </section>

      <AnimatePresence>
        {demoNoticeOpen && (
          <motion.div
            className="demo-modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setDemoNoticeOpen(false);
            }}
          >
            <motion.section
              className="demo-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="demoNoticeTitle"
              aria-describedby="demoNoticeText"
              initial={{ opacity: 0, y: 26, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 14, scale: 0.98 }}
              transition={springEmphasized}
            >
              <button
                ref={demoCloseRef}
                type="button"
                className="demo-modal-close"
                aria-label="Закрыть предупреждение"
                onClick={() => setDemoNoticeOpen(false)}
              >
                <IconClose />
              </button>
              <span className="demo-modal-icon" aria-hidden="true">
                <IconShield />
              </span>
              <span className="eyebrow">Перед регистрацией</span>
              <h3 id="demoNoticeTitle">Это чисто предпросмотр функций</h3>
              <div id="demoNoticeText" className="demo-modal-copy">
                <p>
                  Для вас будет создана отдельная демонстрационная копия
                  «Контура». Внутри уже внесены тестовые клиенты, услуги и
                  транзакции — можно сразу смотреть риск, очередь спасения и
                  Live-монитор.
                </p>
                <p>
                  Все функции работают полностью: меняйте веса модели,
                  загружайте свой JSON-снимок, запускайте симулятор и
                  проверяйте уведомления. Изменения останутся только в вашей
                  демо-копии и не являются боевыми данными Aéza.
                </p>
              </div>
              <label className="demo-check">
                <input
                  type="checkbox"
                  checked={demoAccepted}
                  onChange={(event) => setDemoAccepted(event.target.checked)}
                />
                <span>
                  Понимаю, что это демо-предпросмотр с тестовыми данными
                </span>
              </label>
              <div className="demo-modal-actions">
                <button
                  type="button"
                  className="demo-modal-button demo-modal-button-ghost"
                  onClick={() => setDemoNoticeOpen(false)}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="demo-modal-button demo-modal-button-primary"
                  disabled={!demoAccepted}
                  onClick={continueToRegistration}
                >
                  Продолжить
                  <IconArrowUpRight />
                </button>
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
