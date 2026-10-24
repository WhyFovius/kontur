import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { daysLabel, decimal, integer, money } from "./format";
import {
  RISK_LABELS,
  SERVICE_STATUS_LABELS,
  type ChurnTimelineData,
  type Customer,
  type CustomerList,
  type ModelSettings,
  type RiskLevel,
  type SortKey,
  type SortOrder,
  type Summary,
} from "./types";

type View = "overview" | "customers" | "model";
const PAGE_SIZE = 20;

/* ---------------- icons (stroke, Fluent-style 20px grid) ---------------- */

function Icon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={path} />
    </svg>
  );
}
const IconGrid = () => <Icon path="M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z" />;
const IconPeople = () => <Icon path="M13.5 17v-1.5c0-1.7-2.2-2.7-4.5-2.7S4.5 13.8 4.5 15.5V17M9 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM15.5 4.9a3 3 0 0 1 0 5.3M17.8 12.9c1 .5 1.7 1.3 1.7 2.6V17" />;
const IconSliders = () => <Icon path="M3 6h7M14 6h3M3 13.5h3M10 13.5h7M12 3.8v4.4M8 11.3v4.4" />;
const IconUpload = () => <Icon path="M10 13V3.5M6.8 6 10 2.8 13.2 6M3.5 13.5v2A1.5 1.5 0 0 0 5 17h10a1.5 1.5 0 0 0 1.5-1.5v-2" />;
const IconRefresh = () => <Icon path="M16.5 10a6.5 6.5 0 1 1-1.9-4.5M16.7 2.8v3h-3" />;
const IconLogout = () => <Icon path="M8 3H5a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 5 17h3M13 6.5 16.5 10 13 13.5M16.3 10H8" />;
const IconSun = () => <Icon path="M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM10 2.5v1.6M10 15.9v1.6M2.5 10h1.6M15.9 10h1.6M4.7 4.7l1.1 1.1M14.2 14.2l1.1 1.1M15.3 4.7l-1.1 1.1M5.8 14.2l-1.1 1.1" />;
const IconMoon = () => <Icon path="M16.5 12.5A6.8 6.8 0 0 1 7.5 3.5 8 8 0 1 0 16.5 12.5Z" />;
const IconChevron = () => <Icon path="m7 4.5 5 5.5-5 5.5" />;

/* ---------------- app ---------------- */

export function App() {
  const [username, setUsername] = useState<string | null | undefined>(undefined);
  const [view, setView] = useState<View>("overview");
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    window.localStorage.getItem("kontur-v2.theme") === "dark" ? "dark" : "light",
  );
  const [summary, setSummary] = useState<Summary | null>(null);
  const [timeline, setTimeline] = useState<ChurnTimelineData | null>(null);
  const [queue, setQueue] = useState<Customer[]>([]);
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("kontur-v2.theme", theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);

  const loadCore = useCallback(async () => {
    const [sum, tl, top, cfg] = await Promise.all([
      api<Summary>("/api/v1/analytics/summary"),
      api<ChurnTimelineData>("/api/v1/analytics/churn-timeline"),
      api<CustomerList>("/api/v1/customers?risk=high&sort=score&order=desc&limit=5&offset=0"),
      api<ModelSettings>("/api/v1/model/settings"),
    ]);
    setSummary(sum);
    setTimeline(tl);
    setQueue(top.items);
    setSettings(cfg);
    setLoadError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await api<{ username: string }>("/api/v1/auth/me");
        if (cancelled) return;
        setUsername(me.username);
        await loadCore();
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) setUsername(null);
        else {
          setUsername(null);
          setLoadError(error instanceof Error ? error.message : "Ошибка загрузки");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadCore]);

  const logout = useCallback(async () => {
    try {
      await api("/api/v1/auth/logout", { method: "POST" });
    } catch {
      /* session may already be gone */
    }
    setUsername(null);
    setSummary(null);
    setTimeline(null);
    setQueue([]);
    setSettings(null);
  }, []);

  if (username === undefined) {
    return (
      <div className="boot">
        <div className="boot-logo">К</div>
        <p>Загружаем рабочее пространство…</p>
      </div>
    );
  }

  if (username === null) {
    return (
      <Login
        error={loadError}
        onSuccess={async (name) => {
          setUsername(name);
          await loadCore();
        }}
      />
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar acrylic">
        <div className="brand">
          <span className="brand-tile">К</span>
          <span className="brand-text">
            <strong>Контур</strong>
            <small>v2 · Fluent + Go</small>
          </span>
        </div>
        <nav className="nav" aria-label="Разделы">
          <NavButton active={view === "overview"} onClick={() => setView("overview")} icon={<IconGrid />} label="Обзор" />
          <NavButton active={view === "customers"} onClick={() => setView("customers")} icon={<IconPeople />} label="Клиенты" count={summary?.customerCount} />
          <NavButton active={view === "model"} onClick={() => setView("model")} icon={<IconSliders />} label="Модель риска" />
        </nav>
        <div className="sidebar-foot">
          <span className="user-chip" title={username}>{username}</span>
          <button type="button" className="icon-button" onClick={logout} aria-label="Выйти" title="Выйти">
            <IconLogout />
          </button>
        </div>
      </aside>

      <div className="workspace">
        <Topbar
          title={view === "overview" ? "Обзор" : view === "customers" ? "Клиенты" : "Модель риска"}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          onRefresh={() => loadCore().then(() => showToast("Данные обновлены")).catch((e) => showToast(String(e.message ?? e)))}
          onUploaded={() => loadCore().catch(() => undefined)}
          showToast={showToast}
        />
        <main className="content">
          {loadError && <div className="banner banner-error" role="alert">{loadError}</div>}
          {view === "overview" && (
            <Overview summary={summary} timeline={timeline} queue={queue}
              onOpenCustomers={() => setView("customers")} />
          )}
          {view === "customers" && <Customers settings={settings} showToast={showToast} />}
          {view === "model" && settings && (
            <Model settings={settings} onSaved={(cfg) => { setSettings(cfg); void loadCore(); }} showToast={showToast} />
          )}
          {view === "model" && !settings && <p className="muted">Загружаем настройки модели…</p>}
        </main>
      </div>

      {toast && <div className="toast acrylic-strong" role="status">{toast}</div>}
    </div>
  );
}

function NavButton({ active, onClick, icon, label, count }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count?: number;
}) {
  return (
    <button type="button" className={`nav-item${active ? " is-active" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-label">{label}</span>
      {count != null && <span className="nav-count">{integer(count)}</span>}
    </button>
  );
}

/* ---------------- topbar + upload ---------------- */

function Topbar({ title, theme, onToggleTheme, onRefresh, onUploaded, showToast }: {
  title: string;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onRefresh: () => void;
  onUploaded: () => void;
  showToast: (m: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const onFile = async (file: File) => {
    setUploading(true);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      await api("/api/v1/source/snapshot", { method: "PUT", body: JSON.stringify(parsed) });
      showToast("Снимок загружен, модель пересчитана");
      onUploaded();
    } catch (error) {
      showToast(error instanceof Error ? `Ошибка снимка: ${error.message}` : "Не удалось загрузить снимок");
    } finally {
      setUploading(false);
    }
  };

  return (
    <header className="topbar acrylic">
      <h1>{title}</h1>
      <div className="topbar-actions">
        <button type="button" className="button button-subtle" onClick={onRefresh}>
          <IconRefresh /> Обновить
        </button>
        <button type="button" className="button button-accent" disabled={uploading}
          onClick={() => fileRef.current?.click()}>
          <IconUpload /> {uploading ? "Загружаем…" : "Загрузить снимок"}
        </button>
        <button type="button" className="icon-button" onClick={onToggleTheme}
          aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"} title="Переключить тему">
          {theme === "dark" ? <IconSun /> : <IconMoon />}
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onFile(file);
            event.target.value = "";
          }} />
      </div>
    </header>
  );
}

/* ---------------- login ---------------- */

function Login({ error, onSuccess }: { error: string | null; onSuccess: (name: string) => Promise<void> }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(error);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setLocalError(null);
    try {
      const payload = await api<{ username: string }>("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: login, password }),
      });
      await onSuccess(payload.username);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Не удалось войти");
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card acrylic-strong" onSubmit={submit}>
        <div className="brand brand-login">
          <span className="brand-tile">К</span>
          <span className="brand-text">
            <strong>Контур</strong>
            <small>аналитика риска оттока · v2</small>
          </span>
        </div>
        <h2>Вход в панель</h2>
        <p className="muted">Экспериментальный стек: Go (stdlib) + Fluent-интерфейс. Данные и API — те же, что в основной версии.</p>
        <label className="field">
          <span>Логин</span>
          <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" required maxLength={128} />
        </label>
        <label className="field">
          <span>Пароль</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required maxLength={256} />
        </label>
        {localError && <p className="banner banner-error" role="alert">{localError}</p>}
        <button type="submit" className="button button-accent button-wide" disabled={busy}>
          {busy ? "Проверяем…" : "Войти"}
        </button>
        <p className="footnote">Сессия хранится в защищённой HttpOnly cookie</p>
      </form>
    </div>
  );
}

/* ---------------- overview ---------------- */

function Overview({ summary, timeline, queue, onOpenCustomers }: {
  summary: Summary | null;
  timeline: ChurnTimelineData | null;
  queue: Customer[];
  onOpenCustomers: () => void;
}) {
  if (!summary) return <p className="muted">Загружаем сводку…</p>;
  const total = Math.max(1, summary.highRisk + summary.mediumRisk + summary.lowRisk + summary.unratedCount);
  const segments: { key: RiskLevel; value: number }[] = [
    { key: "high", value: summary.highRisk },
    { key: "medium", value: summary.mediumRisk },
    { key: "low", value: summary.lowRisk },
    { key: "unrated", value: summary.unratedCount },
  ];
  return (
    <>
      <section className="kpi-grid" aria-label="Ключевые показатели">
        <Kpi label="Клиентов в снимке" value={integer(summary.customerCount)} sub={`оценено: ${integer(summary.ratedCount)}`} />
        <Kpi label="Высокий риск" value={integer(summary.highRisk)} sub="клиентов требуют внимания" tone="high" />
        <Kpi label="Выручка под риском · 90 дней" value={money(summary.estimatedLoss)} sub={`в месяц: ${money(summary.monthlyRevenueAtRisk)}`} tone="accent" />
        <Kpi label="Услуг под риском" value={integer(summary.atRiskServices)} sub="ожидают оплаты или истекают без автопродления" />
      </section>

      <section className="grid-2">
        <article className="card acrylic">
          <h3>Распределение по риску</h3>
          <div className="risk-stack" role="img" aria-label={segments.map((s) => `${RISK_LABELS[s.key]}: ${s.value}`).join(", ")}>
            {segments.filter((s) => s.value > 0).map((s) => (
              <span key={s.key} className={`risk-seg risk-${s.key}`} style={{ width: `${(s.value / total) * 100}%` }} />
            ))}
          </div>
          <ul className="legend">
            {segments.map((s) => (
              <li key={s.key}>
                <i className={`dot risk-${s.key}`} aria-hidden="true" />
                {RISK_LABELS[s.key]} — <strong>{integer(s.value)}</strong>
              </li>
            ))}
          </ul>
          <h4>Прогноз непродлений</h4>
          <div className="forecast-row">
            {summary.churnForecast.days.map((day, i) => (
              <span key={day} className="forecast-chip">
                к дню {day}: <strong>{integer(summary.churnForecast.counts[i] ?? 0)}</strong>
              </span>
            ))}
          </div>
        </article>

        <article className="card acrylic">
          <div className="card-head">
            <h3>Очередь на сегодня</h3>
            <button type="button" className="button button-subtle" onClick={onOpenCustomers}>
              Все клиенты <IconChevron />
            </button>
          </div>
          {queue.length === 0 ? (
            <p className="muted">Клиентов высокого риска сейчас нет.</p>
          ) : (
            <ul className="queue">
              {queue.map((c) => (
                <li key={c.id} className="queue-row">
                  <span className="queue-main">
                    <strong>{c.email}</strong>
                    <small>{c.reasons[0] ?? "Нет данных"}</small>
                  </span>
                  <span className="queue-meta">
                    <ScoreBadge customer={c} />
                    <small>{money(c.estimatedLoss)}</small>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      {timeline && <FactForecast timeline={timeline} />}
    </>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "high" | "accent" }) {
  return (
    <article className={`card acrylic kpi${tone ? ` kpi-${tone}` : ""}`}>
      <span className="kpi-label">{label}</span>
      <strong className="kpi-value">{value}</strong>
      <span className="kpi-sub">{sub}</span>
    </article>
  );
}

function FactForecast({ timeline }: { timeline: ChurnTimelineData }) {
  const max = Math.max(1, ...timeline.past.map((b) => b.deleted), ...timeline.future.map((b) => b.servicesAtRisk));
  return (
    <article className="card acrylic">
      <div className="card-head">
        <h3>Динамика оттока услуг: факт vs прогноз</h3>
        <div className="legend legend-inline">
          <span><i className="swatch swatch-fact" /> Факт: удаления</span>
          <span><i className="swatch swatch-forecast" /> Прогноз: под риском</span>
          <span><i className="swatch swatch-expected" /> Ожидаемые непродления</span>
        </div>
      </div>
      <div className="timeline-chart">
        {timeline.past.map((b) => (
          <div key={`p${b.fromDays}`} className="tl-col">
            <span className="tl-value">{integer(b.deleted)}</span>
            <span className="tl-track">
              <span className="tl-bar tl-fact" style={{ height: `${Math.max(2, (b.deleted / max) * 100)}%` }} />
            </span>
            <span className="tl-label">{b.label}</span>
          </div>
        ))}
        <div className="tl-divider" aria-hidden="true"><span>сегодня</span></div>
        {timeline.future.map((b) => (
          <div key={`f${b.fromDays}`} className="tl-col">
            <span className="tl-value">{integer(b.servicesAtRisk)}<small>≈{decimal(b.expectedNonRenewals)}</small></span>
            <span className="tl-track">
              <span className="tl-bar tl-forecast" style={{ height: `${Math.max(2, (b.servicesAtRisk / max) * 100)}%` }} />
              {b.servicesAtRisk > 0 && (
                <span className="tl-dot" style={{ bottom: `${(b.expectedNonRenewals / max) * 100}%` }} />
              )}
            </span>
            <span className="tl-label">{b.label}</span>
          </div>
        ))}
      </div>
      <p className="muted">
        Удалено за 90 дней: <strong>{integer(timeline.totals.deleted90d)}</strong> · Под риском (30 дней):{" "}
        <strong>{integer(timeline.totals.servicesAtRisk30d)}</strong> · Ожидаемые непродления (30 дней):{" "}
        <strong>≈{decimal(timeline.totals.expectedNonRenewals30d)}</strong>
      </p>
      <p className="hint">{timeline.method}</p>
    </article>
  );
}

function ScoreBadge({ customer }: { customer: Customer }) {
  const level = customer.riskLevel || "unrated";
  return (
    <span className={`badge badge-${level}`}>
      {customer.score == null ? RISK_LABELS[level] : `${RISK_LABELS[level]} · ${customer.score}`}
    </span>
  );
}

/* ---------------- customers ---------------- */

function Customers({ settings, showToast }: { settings: ModelSettings | null; showToast: (m: string) => void }) {
  const [risk, setRisk] = useState<RiskLevel | "">("");
  const [sort, setSort] = useState<SortKey>("score");
  const [order, setOrder] = useState<SortOrder>("desc");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<CustomerList>({ items: [], total: 0 });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ sort, order, limit: String(PAGE_SIZE), offset: String(offset) });
      if (risk) params.set("risk", risk);
      setData(await api<CustomerList>(`/api/v1/customers?${params}`));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Не удалось загрузить клиентов");
    } finally {
      setLoading(false);
    }
  }, [risk, sort, order, offset, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalWeight = useMemo(
    () => Object.values(settings?.weights ?? {}).reduce((sum, w) => sum + Math.max(0, w), 0) || 1,
    [settings],
  );

  const filters: { key: RiskLevel | ""; label: string }[] = [
    { key: "", label: "Все" },
    { key: "high", label: "Высокий" },
    { key: "medium", label: "Средний" },
    { key: "low", label: "Низкий" },
    { key: "unrated", label: "Нет оценки" },
  ];

  return (
    <section className="card acrylic">
      <div className="toolbar">
        <div className="chip-row" role="group" aria-label="Фильтр по риску">
          {filters.map((f) => (
            <button key={f.key || "all"} type="button"
              className={`chip${risk === f.key ? " is-active" : ""}`}
              onClick={() => { setRisk(f.key); setOffset(0); }}>
              {f.label}
            </button>
          ))}
        </div>
        <label className="select-wrap">
          Сортировка
          <select value={sort} onChange={(e) => { setSort(e.target.value as SortKey); setOffset(0); }}>
            <option value="score">По оценке риска</option>
            <option value="id">По ID</option>
            <option value="email">По email</option>
            <option value="balance">По балансу</option>
            <option value="totalReplenished">По пополнениям</option>
          </select>
        </label>
        <button type="button" className="button button-subtle"
          onClick={() => setOrder((o) => (o === "desc" ? "asc" : "desc"))}
          aria-label="Порядок сортировки">
          {order === "desc" ? "Сначала большие" : "Сначала меньшие"}
        </button>
      </div>

      {loading ? <p className="muted">Загружаем клиентов…</p> : data.items.length === 0 ? (
        <p className="muted">По этому фильтру клиентов нет.</p>
      ) : (
        <div className="table" role="list">
          {data.items.map((c) => (
            <CustomerRow key={c.id} customer={c} settings={settings} totalWeight={totalWeight}
              expanded={expandedId === c.id}
              onToggle={() => setExpandedId((id) => (id === c.id ? null : c.id))} />
          ))}
        </div>
      )}

      <div className="pagination">
        <span className="muted">{integer(data.total)} клиентов</span>
        <span className="pagination-actions">
          <button type="button" className="button button-subtle" disabled={offset === 0}
            onClick={() => setOffset((v) => Math.max(0, v - PAGE_SIZE))}>Назад</button>
          <button type="button" className="button button-subtle" disabled={offset + PAGE_SIZE >= data.total}
            onClick={() => setOffset((v) => v + PAGE_SIZE)}>Вперёд</button>
        </span>
      </div>
    </section>
  );
}

function CustomerRow({ customer, settings, totalWeight, expanded, onToggle }: {
  customer: Customer;
  settings: ModelSettings | null;
  totalWeight: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const active = Object.entries(customer.features ?? {}).filter(([, on]) => on);
  return (
    <div className={`row-item${expanded ? " is-open" : ""}`} role="listitem">
      <button type="button" className="row-main" onClick={onToggle} aria-expanded={expanded}>
        <span className="row-id">#{customer.id}</span>
        <span className="row-client">
          <strong>{customer.email}</strong>
          <small>{customer.reasons[0] ?? "Нет данных"}</small>
        </span>
        <span className="row-num" data-label="Баланс">{money(customer.balance)}</span>
        <span className="row-num" data-label="Потеря">{money(customer.estimatedLoss)}</span>
        <span className="row-badge"><ScoreBadge customer={customer} /></span>
        <span className={`row-chev${expanded ? " is-open" : ""}`}><IconChevron /></span>
      </button>
      {expanded && (
        <div className="row-detail">
          <div className="detail-grid">
            <div>
              <h4>Причины оценки</h4>
              <ul className="plain">
                {customer.reasons.map((r) => <li key={r}>{r}</li>)}
              </ul>
              {active.length > 0 && settings && (
                <>
                  <h4>Активные сигналы</h4>
                  <ul className="plain">
                    {active.map(([key]) => (
                      <li key={key}>
                        {settings.features[key] ?? key} —{" "}
                        <strong>{Math.round(((settings.weights[key] ?? 0) / totalWeight) * 100)} бал.</strong>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <div>
              <h4>Деньги и сроки</h4>
              <ul className="plain">
                <li>Доступный баланс: <strong>{money(customer.availableBalance ?? customer.balance)}</strong></li>
                <li>Пополнено за всё время: <strong>{money(customer.totalReplenished)}</strong></li>
                <li>Выручка в месяц: <strong>{money(customer.monthlyRevenue)}</strong></li>
                <li>Ближайшее окончание: <strong>{daysLabel(customer.daysToExpiry)}</strong></li>
              </ul>
              <h4>Услуги ({customer.services.length})</h4>
              <ul className="plain">
                {customer.services.map((s, i) => (
                  <li key={s.id ?? i}>
                    {s.name ?? "Услуга"} — {SERVICE_STATUS_LABELS[s.status ?? ""] ?? s.status ?? "—"}
                    {s.price != null ? ` · ${money(s.price)}` : ""}
                    {s.autoprolong ? " · автопродление" : ""}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- model ---------------- */

function Model({ settings, onSaved, showToast }: {
  settings: ModelSettings;
  onSaved: (cfg: ModelSettings) => void;
  showToast: (m: string) => void;
}) {
  const [draft, setDraft] = useState<Record<string, number>>(settings.weights);
  const [saving, setSaving] = useState(false);

  useEffect(() => setDraft(settings.weights), [settings]);

  const dirty = useMemo(
    () => Object.keys(settings.weights).some((k) => (draft[k] ?? 0) !== settings.weights[k]),
    [draft, settings],
  );
  const total = Object.values(draft).reduce((sum, w) => sum + Math.max(0, w), 0) || 1;

  const save = async () => {
    setSaving(true);
    try {
      const cfg = await api<ModelSettings>("/api/v1/model/settings", {
        method: "PATCH",
        body: JSON.stringify({ weights: draft }),
      });
      onSaved(cfg);
      showToast("Веса сохранены, рейтинг пересчитан");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Не удалось сохранить веса");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card acrylic model-card">
      <div className="card-head">
        <div>
          <h3>Веса признаков риска</h3>
          <p className="muted">
            Пороги: высокий ≥ {settings.thresholds.high ?? 65}, средний ≥ {settings.thresholds.medium ?? 35}.
            Изменения вступают в силу после сохранения и хранятся на сервере.
          </p>
        </div>
        <div className="model-actions">
          <button type="button" className="button button-subtle" disabled={!dirty || saving}
            onClick={() => setDraft(settings.weights)}>Сбросить</button>
          <button type="button" className="button button-accent" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Сохраняем…" : "Сохранить веса"}
          </button>
        </div>
      </div>
      <div className="weight-list">
        {Object.entries(settings.features).map(([key, label]) => (
          <div key={key} className="weight-item">
            <div className="weight-head">
              <label htmlFor={`w-${key}`}>{label}</label>
              <span className="weight-value">
                {Math.round(draft[key] ?? 0)}
                <small>{Math.round(((draft[key] ?? 0) / total) * 100)}% скора</small>
              </span>
            </div>
            <input id={`w-${key}`} className="slider" type="range" min={0} max={100} step={1}
              value={draft[key] ?? 0}
              style={{ "--fill": `${draft[key] ?? 0}%` } as React.CSSProperties}
              onChange={(e) => setDraft((d) => ({ ...d, [key]: Number(e.target.value) }))} />
          </div>
        ))}
      </div>
      {dirty && <p className="banner banner-warn" role="status">Есть несохранённые изменения весов.</p>}
    </section>
  );
}
