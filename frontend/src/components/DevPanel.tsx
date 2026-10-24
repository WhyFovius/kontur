import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { api, ApiError } from "../api";
import { integer } from "../format";
import { springEmphasized, springExEffects, springSnappy } from "../motion";
import type {
  AlertSeverity,
  Customer,
  CustomerRealtimeHistory,
  DemoScenario,
  ReactionAction,
  ReactionTemplate,
  RealtimeDashboardData,
  RealtimeEvent,
  RealtimeEventList,
  RealtimeStatus,
  RiskLevel,
  SimulatorStatus,
} from "../types";
import { MascotImage } from "./Brand";
import { IconBolt, IconCheck, IconClose, IconMail, IconShield } from "../icons";

const SCENARIOS: { id: DemoScenario; label: string; hint: string }[] = [
  { id: "NORMAL_ACTIVITY", label: "Обычная активность", hint: "спокойный сигнал без спама" },
  { id: "ACTIVITY_DROP", label: "Падение активности", hint: "сессии резко проседают" },
  { id: "CHURN_RISK_SPIKE", label: "Скачок риска", hint: "активность + платёжный сбой" },
  { id: "HIGH_RISK_THRESHOLD", label: "Порог 80+", hint: "гарантированный critical-path" },
  { id: "CUSTOMER_RECOVERY", label: "Восстановление", hint: "клиент возвращается" },
  { id: "NEW_CUSTOMER_ACTIVITY", label: "Новый клиент", hint: "отдельный DEMO-профиль" },
];

const EVENT_TYPE_LABELS: Record<string, string> = {
  activity_observed: "Активность",
  activity_drop: "Падение активности",
  churn_risk_increased: "Риск вырос",
  high_risk_threshold_crossed: "Порог риска",
  customer_recovered: "Восстановление",
  new_customer_activity: "Новый клиент",
};

const SEVERITY_LABELS: Record<AlertSeverity, string> = {
  critical: "критично",
  warning: "важно",
  info: "инфо",
};

type SimulatorScenario = DemoScenario | "MIXED";

interface DevPanelProps {
  customers: Customer[];
  onOpenCustomer: (customerId: string, riskLevel: RiskLevel | null) => void;
  onPortfolioChange?: () => void;
}

function parseSse<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function deltaLabel(delta: number): string {
  const points = Math.round(delta * 100);
  return `${points > 0 ? "+" : ""}${points}`;
}

function MiniLine({ points }: { points: { label: string; value: number }[] }) {
  if (points.length === 0) return <div className="dev-chart-empty">Событий пока нет — запустите DEMO-сценарий.</div>;
  const coords = points.map((point, index) => {
    const x = points.length === 1 ? 50 : (index / (points.length - 1)) * 100;
    const y = 42 - (Math.max(0, Math.min(100, point.value)) / 100) * 38;
    return `${x},${y}`;
  });
  return (
    <div className="dev-line-chart">
      <svg viewBox="0 0 100 46" preserveAspectRatio="none" aria-hidden="true">
        <path className="dev-line-area" d={`M0,46 L${coords.join(" L")} L100,46 Z`} />
        <polyline points={coords.join(" ")} />
      </svg>
      <div><span>{points[0]?.label}</span><strong>{points.at(-1)?.value ?? 0}</strong><span>{points.at(-1)?.label}</span></div>
    </div>
  );
}

function MiniBars({ points }: { points: { label: string; value: number }[] }) {
  if (points.length === 0) return <div className="dev-chart-empty">Часовой поток появится после первых событий.</div>;
  const max = Math.max(1, ...points.map((point) => point.value));
  return (
    <div className="dev-bars" aria-hidden="true">
      {points.map((point) => (
        <span key={`${point.label}-${point.value}`} style={{ height: `${Math.max(8, (point.value / max) * 100)}%` }}>
          <i>{point.value}</i><small>{point.label}</small>
        </span>
      ))}
    </div>
  );
}

export function DevPanel({ customers, onOpenCustomer, onPortfolioChange }: DevPanelProps) {
  const [status, setStatus] = useState<RealtimeStatus | null>(null);
  const [dashboard, setDashboard] = useState<RealtimeDashboardData | null>(null);
  const [events, setEvents] = useState<RealtimeEvent[]>([]);
  const [templates, setTemplates] = useState<ReactionTemplate[]>([]);
  const [outbox, setOutbox] = useState<ReactionAction[]>([]);
  const [history, setHistory] = useState<CustomerRealtimeHistory | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [scenario, setScenario] = useState<DemoScenario>("HIGH_RISK_THRESHOLD");
  const [simulatorScenario, setSimulatorScenario] = useState<SimulatorScenario>("MIXED");
  const [customerId, setCustomerId] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState(5);
  const [severity, setSeverity] = useState("");
  const [eventType, setEventType] = useState("");
  const [mode, setMode] = useState("");
  const [query, setQuery] = useState("");
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const knownEventIds = useRef(new Set<string>());
  const refreshTimer = useRef<number | null>(null);
  const filtersRef = useRef({ severity, eventType, mode, query });
  filtersRef.current = { severity, eventType, mode, query };

  const selectedEvent = useMemo(
    () => events.find((event) => event.eventId === selectedEventId) ?? events[0] ?? null,
    [events, selectedEventId],
  );
  const customerOptions = useMemo(
    () => [...customers].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 100),
    [customers],
  );
  const simulator = status?.simulator;

  const eventsPath = useCallback(() => {
    const params = new URLSearchParams({ limit: "60" });
    if (severity) params.set("severity", severity);
    if (eventType) params.set("event_type", eventType);
    if (mode) params.set("mode", mode);
    if (query.trim()) params.set("q", query.trim());
    return `/api/v1/realtime/events?${params.toString()}`;
  }, [eventType, mode, query, severity]);

  const loadEvents = useCallback(async () => {
    const payload = await api<RealtimeEventList>(eventsPath());
    payload.items.forEach((event) => knownEventIds.current.add(event.eventId));
    setEvents(payload.items);
    setSelectedEventId((current) =>
      current && payload.items.some((event) => event.eventId === current)
        ? current
        : payload.items[0]?.eventId ?? null,
    );
  }, [eventsPath]);

  const loadSupportData = useCallback(async () => {
    const [nextStatus, nextDashboard, nextTemplates, nextOutbox] = await Promise.all([
      api<RealtimeStatus>("/api/v1/realtime/status"),
      api<RealtimeDashboardData>("/api/v1/realtime/dashboard?hours=24"),
      api<{ items: ReactionTemplate[] }>("/api/v1/realtime/templates"),
      api<{ items: ReactionAction[] }>("/api/v1/realtime/outbox?limit=20"),
    ]);
    setStatus(nextStatus);
    setDashboard(nextDashboard);
    setTemplates(nextTemplates.items);
    setOutbox(nextOutbox.items);
  }, []);

  const scheduleSupportRefresh = useCallback(() => {
    if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      loadSupportData().catch(() => undefined);
    }, 350);
  }, [loadSupportData]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadEvents(), loadSupportData()])
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof ApiError ? loadError.message : "Не удалось загрузить Live-монитор");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Initial load only; filter changes have their own effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (loading) return undefined;
    const timer = window.setTimeout(() => {
      loadEvents().catch((loadError: unknown) => {
        setError(loadError instanceof ApiError ? loadError.message : "Не удалось обновить события");
      });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [loadEvents, loading]);

  useEffect(() => {
    const source = new EventSource("/api/v1/realtime/stream");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.addEventListener("realtime_event", (raw) => {
      const event = parseSse<RealtimeEvent>(raw);
      if (!event || knownEventIds.current.has(event.eventId)) return;
      knownEventIds.current.add(event.eventId);
      const active = filtersRef.current;
      const matches =
        (!active.severity || event.severity === active.severity) &&
        (!active.eventType || event.type === active.eventType) &&
        (!active.mode || event.mode === active.mode) &&
        (!active.query || `${event.eventId} ${event.customerEmail ?? ""}`.toLowerCase().includes(active.query.toLowerCase()));
      if (matches) {
        setEvents((previous) => [event, ...previous].slice(0, 80));
        setSelectedEventId((current) => current ?? event.eventId);
      }
      scheduleSupportRefresh();
      onPortfolioChange?.();
    });
    return () => {
      source.close();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [onPortfolioChange, scheduleSupportRefresh]);

  useEffect(() => {
    if (!selectedEvent?.customerId) {
      setHistory(null);
      return undefined;
    }
    let cancelled = false;
    api<CustomerRealtimeHistory>(`/api/v1/realtime/customers/${encodeURIComponent(selectedEvent.customerId)}/history?limit=30`)
      .then((payload) => {
        if (!cancelled) setHistory(payload);
      })
      .catch(() => {
        if (!cancelled) setHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEvent?.customerId, selectedEvent?.id]);

  const runAction = useCallback(async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof ApiError ? actionError.message : "Операция не выполнена");
    } finally {
      setBusy(null);
    }
  }, []);

  const generate = () => runAction("generate", async () => {
    const event = await api<RealtimeEvent>("/api/v1/demo/generate", {
      method: "POST",
      body: JSON.stringify({
        scenario,
        customerId: customerId || null,
      }),
    });
    if (!knownEventIds.current.has(event.eventId)) {
      knownEventIds.current.add(event.eventId);
      setEvents((previous) => [event, ...previous].slice(0, 80));
    }
    setSelectedEventId(event.eventId);
    await loadSupportData();
    onPortfolioChange?.();
  });

  const toggleSimulator = () => runAction("simulator", async () => {
    const path = simulator?.running ? "/api/v1/demo/simulator/stop" : "/api/v1/demo/simulator/start";
    const payload = await api<{ simulator: SimulatorStatus }>(path, {
      method: "POST",
      body: simulator?.running ? undefined : JSON.stringify({ intervalSeconds, scenario: simulatorScenario }),
    });
    setStatus((previous) => previous ? { ...previous, simulator: payload.simulator } : previous);
    scheduleSupportRefresh();
  });

  const resetDemo = () => {
    if (!window.confirm("Сбросить только DEMO-события, расчёты и simulated-действия? Live-клиенты не изменятся.")) return;
    void runAction("reset", async () => {
      await api("/api/v1/demo/reset", { method: "POST" });
      knownEventIds.current.clear();
      setEvents([]);
      setHistory(null);
      setSelectedEventId(null);
      await Promise.all([loadEvents(), loadSupportData()]);
      onPortfolioChange?.();
    });
  };

  const toggleTemplate = (template: ReactionTemplate) => runAction(`template-${template.id}`, async () => {
    const updated = await api<ReactionTemplate>(`/api/v1/realtime/templates/${template.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !template.enabled }),
    });
    setTemplates((previous) => previous.map((item) => item.id === updated.id ? updated : item));
  });

  const distributionTotal = dashboard
    ? Math.max(1, dashboard.distribution.high + dashboard.distribution.medium + dashboard.distribution.low)
    : 1;

  return (
    <section className="dev-shell" aria-label="Разработческая панель realtime-событий">
      <div className="dev-status-strip">
        <span className={`dev-live-pill${connected ? " is-live" : ""}`}>
          <i aria-hidden="true" /> {connected ? "SSE подключён" : "SSE переподключается"}
        </span>
        <span className="dev-mode-pill">DEMO работает полностью</span>
        <span className={`dev-mode-pill${status?.liveAvailable ? " is-live" : " is-muted"}`}>
          LIVE: {status?.liveAvailable ? "подключён" : "адаптер не настроен"}
        </span>
        <span>Событий: {integer(status?.eventCounts.total ?? 0)} · DEMO {integer(status?.eventCounts.demo ?? 0)} · LIVE {integer(status?.eventCounts.live ?? 0)}</span>
        {simulator?.lastError && <strong className="dev-inline-error">Симулятор: {simulator.lastError}</strong>}
      </div>

      {error && (
        <div className="dev-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Закрыть ошибку"><IconClose /></button>
        </div>
      )}

      <div className="dev-metrics" aria-label="Показатели realtime-мониторинга">
        {[
          ["Клиентов под наблюдением", dashboard?.trackedCustomers ?? "—"],
          ["Высокий риск сейчас", dashboard?.highRiskCustomers ?? "—"],
          ["Событий за 24 часа", dashboard?.eventsInPeriod ?? "—"],
          ["Критических событий", dashboard?.criticalEvents ?? "—"],
          ["Средний риск", dashboard ? `${dashboard.averageRiskPercent}` : "—"],
          ["Улучшили состояние", dashboard?.improvedCustomers ?? "—"],
        ].map(([label, value]) => (
          <article className="dev-metric" key={label}>
            <span>{label}</span><strong>{typeof value === "number" ? integer(value) : value}</strong>
          </article>
        ))}
      </div>

      <div className="dev-grid dev-grid-main">
        <motion.article className="panel dev-card dev-generator" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={springEmphasized}>
          <div className="dev-card-head">
            <div>
              <span className="eyebrow">Dev Panel · DEMO</span>
              <h2>Генератор событий</h2>
              <p>Каждое событие проходит серверный processor: расчёт, история, anti-spam, уведомление и реакцию.</p>
            </div>
            <span className="dev-mascot-badge" aria-hidden="true"><MascotImage pose={simulator?.running ? "business" : "calm"} /></span>
          </div>

          <div className="dev-scenario-grid" role="radiogroup" aria-label="Сценарий DEMO-события">
            {SCENARIOS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={scenario === item.id}
                className={`dev-scenario${scenario === item.id ? " is-active" : ""}`}
                onClick={() => setScenario(item.id)}
              >
                <strong>{item.label}</strong><span>{item.hint}</span>
              </button>
            ))}
          </div>

          <div className="dev-form-grid">
            <label>
              Клиент
              <select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
                <option value="">Случайный клиент</option>
                {customerOptions.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.email} · {customer.score ?? "—"}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Сценарий симулятора
              <select value={simulatorScenario} onChange={(event) => setSimulatorScenario(event.target.value as SimulatorScenario)}>
                <option value="MIXED">Chaos Mix</option>
                {SCENARIOS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label>
              Интервал, сек.
              <span className="dev-interval">
                <input type="range" min="2" max="60" step="1" value={intervalSeconds} onChange={(event) => setIntervalSeconds(Number(event.target.value))} />
                <input type="number" min="2" max="60" value={intervalSeconds} onChange={(event) => setIntervalSeconds(Math.max(2, Math.min(60, Number(event.target.value) || 2)))} />
              </span>
            </label>
          </div>

          <div className="dev-actions">
            <button type="button" className="dev-button dev-button-primary" onClick={() => void generate()} disabled={busy !== null}>
              <IconBolt /> {busy === "generate" ? "Создаём…" : "Сгенерировать событие"}
            </button>
            <button type="button" className={`dev-button${simulator?.running ? " is-stop" : ""}`} onClick={() => void toggleSimulator()} disabled={busy !== null}>
              {simulator?.running ? "Остановить поток" : "Запустить симулятор"}
            </button>
            <button type="button" className="dev-button dev-button-ghost" onClick={resetDemo} disabled={busy !== null}>
              Сбросить DEMO
            </button>
          </div>
          <p className="dev-sim-status">
            {simulator?.running
              ? <>Поток работает: {simulator.scenario}, каждые {simulator.intervalSeconds} сек. Сгенерировано {integer(simulator.generatedCount)}.</>
              : "Симулятор остановлен. Ручная генерация всё равно создаёт настоящее сохранённое событие."}
          </p>
        </motion.article>

        <motion.article className="panel dev-card" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ ...springEmphasized, delay: 0.05 }}>
          <div className="dev-card-head">
            <div>
              <span className="eyebrow">Источники</span>
              <h2>DEMO честно отделён от LIVE</h2>
            </div>
            <IconShield />
          </div>
          <div className="dev-sources">
            {(status?.sources ?? []).map((source) => (
              <div className="dev-source" key={source.name}>
                <span className={`dev-source-dot${source.available ? " is-on" : ""}`} aria-hidden="true" />
                <div><strong>{source.label}</strong><span>{source.message}</span></div>
                <b>{source.mode}</b>
              </div>
            ))}
          </div>
          <div className="dev-thresholds">
            <span>Средний риск от <b>{status?.thresholds.medium ?? 35}</b></span>
            <span>Высокий от <b>{status?.thresholds.high ?? 65}</b></span>
            <span>Критично от <b>{status?.thresholds.critical ?? 80}</b></span>
            <span>Значимый скачок <b>{status?.thresholds.significantDelta ?? 10}</b></span>
            <span>Cooldown <b>{status?.thresholds.notificationCooldownSeconds ?? 300} сек.</b></span>
          </div>
          <p className="dev-method">{dashboard?.method ?? "Загружаем методику…"}</p>
        </motion.article>
      </div>

      <div className="dev-grid dev-grid-charts">
        <article className="panel dev-card">
          <div className="dev-card-head compact"><div><span className="eyebrow">Динамика</span><h2>Средний риск расчётов</h2></div></div>
          <MiniLine points={dashboard?.riskSeries ?? []} />
        </article>
        <article className="panel dev-card">
          <div className="dev-card-head compact"><div><span className="eyebrow">Поток</span><h2>События по часам</h2></div></div>
          <MiniBars points={dashboard?.eventSeries ?? []} />
        </article>
        <article className="panel dev-card">
          <div className="dev-card-head compact"><div><span className="eyebrow">Портфель</span><h2>Распределение риска</h2></div></div>
          <div className="dev-distribution" aria-hidden="true">
            <span className="is-high" style={{ width: `${((dashboard?.distribution.high ?? 0) / distributionTotal) * 100}%` }} />
            <span className="is-medium" style={{ width: `${((dashboard?.distribution.medium ?? 0) / distributionTotal) * 100}%` }} />
            <span className="is-low" style={{ width: `${((dashboard?.distribution.low ?? 0) / distributionTotal) * 100}%` }} />
          </div>
          <div className="dev-distribution-labels">
            <span>Высокий <b>{dashboard?.distribution.high ?? 0}</b></span>
            <span>Средний <b>{dashboard?.distribution.medium ?? 0}</b></span>
            <span>Низкий <b>{dashboard?.distribution.low ?? 0}</b></span>
          </div>
        </article>
      </div>

      <div className="dev-feed-layout">
        <article className="panel dev-card dev-feed">
          <div className="dev-card-head">
            <div>
              <span className="eyebrow">Event Feed</span>
              <h2>События в реальном времени</h2>
              <p>SSE replay не теряет события после переподключения; дубли отсекаются по eventId.</p>
            </div>
            <span className="dev-count">{integer(events.length)}</span>
          </div>
          <div className="dev-filters">
            <label className="dev-search">Поиск<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="email, customer ID, eventId" /></label>
            <label>Severity<select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="">Все</option><option value="critical">critical</option><option value="warning">warning</option><option value="info">info</option></select></label>
            <label>Тип<select value={eventType} onChange={(event) => setEventType(event.target.value)}><option value="">Все</option>{Object.entries(EVENT_TYPE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
            <label>Режим<select value={mode} onChange={(event) => setMode(event.target.value)}><option value="">Все</option><option value="DEMO">DEMO</option><option value="LIVE">LIVE</option></select></label>
          </div>

          <div className="dev-event-list" aria-live="polite">
            {loading ? (
              <div className="dev-empty">Подключаем мониторинг…</div>
            ) : events.length === 0 ? (
              <div className="dev-empty"><MascotImage pose="calm" /><strong>Пока тихо.</strong><span>Aéza-тян ждёт первое DEMO-событие.</span></div>
            ) : events.map((event) => (
              <motion.button
                key={event.eventId}
                type="button"
                className={`dev-event dev-severity-${event.severity}${selectedEvent?.eventId === event.eventId ? " is-selected" : ""}`}
                onClick={() => setSelectedEventId(event.eventId)}
                initial={{ opacity: 0, y: 10, scale: 0.985 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={springSnappy}
              >
                <span className="dev-event-score"><strong>{event.riskPercent}</strong><small>{deltaLabel(event.riskDelta)}</small></span>
                <span className="dev-event-copy">
                  <span className="dev-event-top"><b>{EVENT_TYPE_LABELS[event.type] ?? event.type}</b><em>{event.mode}</em><time>{timeLabel(event.timestamp)}</time></span>
                  <strong>{event.customerEmail ?? event.customerId ?? "Портфель"}</strong>
                  <span>{event.reasons[0] ?? event.reason}</span>
                  <small>
                    {SEVERITY_LABELS[event.severity]} · было {Math.round((event.previousRiskScore ?? 0) * 100)}
                    {event.notificationCreated ? " · уведомление создано" : event.suppressedReason ? ` · подавлено: ${event.suppressedReason}` : " · без уведомления"}
                    {event.actions.length ? ` · реакция: ${event.actions[0].channel}` : ""}
                  </small>
                </span>
              </motion.button>
            ))}
          </div>
        </article>

        <aside className="dev-inspector-stack">
          <article className="panel dev-card dev-detail">
            <div className="dev-card-head compact">
              <div><span className="eyebrow">Flight Recorder</span><h2>Детали события</h2></div>
              {selectedEvent?.notificationCreated && <span className="dev-notified"><IconCheck /> Aéza-тян уведомлена</span>}
            </div>
            {selectedEvent ? (
              <>
                <div className="dev-detail-title">
                  <strong>{selectedEvent.customerEmail ?? "Клиент"}</strong>
                  <span>{selectedEvent.customerId} · {selectedEvent.eventId}</span>
                </div>
                <div className="dev-risk-transition">
                  <span><small>Было</small><b>{Math.round((selectedEvent.previousRiskScore ?? 0) * 100)}</b></span>
                  <i aria-hidden="true">→</i>
                  <span><small>Стало</small><b>{selectedEvent.riskPercent}</b></span>
                  <em className={selectedEvent.riskDelta >= 0 ? "is-up" : "is-down"}>{deltaLabel(selectedEvent.riskDelta)}</em>
                </div>
                <ul className="dev-reasons">{selectedEvent.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                {selectedEvent.customerId && customers.some((customer) => customer.id === selectedEvent.customerId) && (
                  <button type="button" className="dev-button" onClick={() => onOpenCustomer(selectedEvent.customerId!, selectedEvent.riskLevel)}>
                    Открыть клиента в очереди
                  </button>
                )}
                <details className="dev-raw"><summary>Raw details</summary><pre>{JSON.stringify(selectedEvent.details, null, 2)}</pre></details>
                <div className="dev-history">
                  <h3>История расчётов клиента</h3>
                  {history?.calculations.length ? history.calculations.map((calculation) => (
                    <div className="dev-history-row" key={calculation.eventId}>
                      <span>{timeLabel(calculation.calculatedAt)}</span>
                      <strong>{calculation.riskPercent}</strong>
                      <em className={calculation.riskDelta >= 0 ? "is-up" : "is-down"}>{deltaLabel(calculation.riskDelta)}</em>
                      <small>база {calculation.baseScore ?? "—"} + DEMO {calculation.demoModifier}</small>
                    </div>
                  )) : <p>Истории пока нет.</p>}
                </div>
              </>
            ) : <p className="dev-method">Выберите событие или сгенерируйте первое.</p>}
          </article>

          <article className="panel dev-card dev-autopilot">
            <div className="dev-card-head compact">
              <div><span className="eyebrow">Autopilot</span><h2>Шаблоны реакций</h2></div>
              <IconMail />
            </div>
            <p className="dev-method">Система сама выбирает соцсеть, если контакт указан, иначе email. В DEMO действие честно помечается simulated_sent и не уходит наружу.</p>
            <div className="dev-template-list">
              {templates.map((template) => (
                <div className="dev-template" key={template.id}>
                  <div>
                    <strong>{template.name}</strong>
                    <span>{template.triggerTypes.map((type) => EVENT_TYPE_LABELS[type] ?? type).join(" · ")}</span>
                    <small>{template.channelStrategy === "social_first" ? "сначала соцсети, потом email" : "сначала email"} · cooldown {integer(template.cooldownSeconds)} сек.</small>
                  </div>
                  <button
                    type="button"
                    className={`dev-switch${template.enabled ? " is-on" : ""}`}
                    role="switch"
                    aria-checked={template.enabled}
                    aria-label={`${template.enabled ? "Выключить" : "Включить"} шаблон ${template.name}`}
                    onClick={() => void toggleTemplate(template)}
                    disabled={busy !== null}
                  ><span /></button>
                  <details><summary>Текст</summary><b>{template.subject}</b><p>{template.body}</p></details>
                </div>
              ))}
            </div>
          </article>

          <article className="panel dev-card dev-outbox-card">
            <div className="dev-card-head compact"><div><span className="eyebrow">Outbox</span><h2>Выполненные реакции</h2></div></div>
            <AnimatePresence initial={false}>
              {outbox.length === 0 ? (
                <p className="dev-method">Реакций пока нет. Скачок риска создаст первую запись.</p>
              ) : outbox.slice(0, 7).map((action) => (
                <motion.div className="dev-outbox" key={action.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={springExEffects}>
                  <span className={`dev-channel dev-channel-${action.channel}`}>{action.channel}</span>
                  <div><strong>{action.subject}</strong><span>{action.recipient ?? "канал не указан"} · {action.status} · {action.mode}</span><small>{action.body}</small></div>
                </motion.div>
              ))}
            </AnimatePresence>
          </article>
        </aside>
      </div>
    </section>
  );
}
