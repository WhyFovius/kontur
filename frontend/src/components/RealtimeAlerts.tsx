import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { api } from "../api";
import { integer, money } from "../format";
import { springEmphasized, springExEffects, springSnappy } from "../motion";
import type {
  AlertSeverity,
  NotificationList,
  NotificationReadResult,
  RiskNotification,
} from "../types";
import { MascotImage } from "./Brand";
import { IconBell, IconCheck, IconClose } from "../icons";

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: "критично",
  warning: "важно",
  info: "инфо",
};

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function sortNotifications(items: RiskNotification[]): RiskNotification[] {
  return [...items].sort((a, b) => {
    if (a.isRead !== b.isRead) return a.isRead ? 1 : -1;
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    return severity || b.id - a.id;
  });
}

function parseEvent<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

function relativeTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 45) return "только что";
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} мин назад`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} ч назад`;
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function thoughtPrefix(item: RiskNotification): string {
  if (item.severity === "critical") return "Так, это срочно.";
  if (item.severity === "warning") return "Заметила важный сигнал.";
  return "Проверила портфель.";
}

interface RealtimeAlertsProps {
  onOpenCustomer: (customerId: string, riskLevel: RiskNotification["riskLevel"]) => void;
  onPortfolioChange?: () => void;
}

/**
 * Aéza-тян realtime risk inbox.
 *
 * One EventSource carries only newly persisted backend episodes; a slow
 * REST fallback runs only while that stream is not open.  All animation
 * is transform/opacity, and state is local to this widget so incoming
 * alerts do not re-render the whole dashboard.
 */
export function RealtimeAlerts({ onOpenCustomer, onPortfolioChange }: RealtimeAlertsProps) {
  const [items, setItems] = useState<RiskNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [criticalCount, setCriticalCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [thought, setThought] = useState<RiskNotification | null>(null);
  const [minimumScore, setMinimumScore] = useState(65);
  const knownMaxIdRef = useRef(0);
  const initializedRef = useRef(false);
  const thoughtTimerRef = useRef<number | null>(null);

  const showThought = useCallback((item: RiskNotification) => {
    setThought(item);
    if (thoughtTimerRef.current) window.clearTimeout(thoughtTimerRef.current);
    thoughtTimerRef.current = window.setTimeout(() => setThought(null), 9000);
  }, []);

  const mergeItems = useCallback((incoming: RiskNotification[]) => {
    setItems((previous) => {
      const byId = new Map(previous.map((item) => [item.id, item]));
      incoming.forEach((item) => byId.set(item.id, item));
      return sortNotifications([...byId.values()]).slice(0, 80);
    });
  }, []);

  const acceptIncoming = useCallback(
    (incoming: RiskNotification[], announceNew: boolean) => {
      const fresh = incoming.filter(
        (item) => item.id > knownMaxIdRef.current && !item.isRead,
      );
      const nextMax = incoming.reduce(
        (max, item) => Math.max(max, item.id),
        knownMaxIdRef.current,
      );
      knownMaxIdRef.current = nextMax;
      mergeItems(incoming);
      if (announceNew && fresh.length > 0) {
        showThought(sortNotifications(fresh)[0]);
        onPortfolioChange?.();
      }
    },
    [mergeItems, onPortfolioChange, showThought],
  );

  const load = useCallback(async () => {
    const payload = await api<NotificationList>("/api/v1/notifications?limit=50");
    const wasInitialized = initializedRef.current;
    initializedRef.current = true;
    setUnreadCount(payload.unreadCount);
    setCriticalCount(payload.criticalCount);
    acceptIncoming(payload.items, wasInitialized);
    if (!wasInitialized) {
      const firstUnread = sortNotifications(payload.items).find((item) => !item.isRead);
      if (firstUnread) {
        window.setTimeout(() => showThought(firstUnread), 650);
      }
    }
  }, [acceptIncoming, showThought]);

  useEffect(() => {
    let cancelled = false;
    load().catch(() => undefined);

    const source = new EventSource("/api/v1/events/stream");
    source.onopen = () => {
      if (!cancelled) setConnected(true);
    };
    source.onerror = () => {
      if (!cancelled) setConnected(false);
    };
    source.addEventListener("snapshot", (event) => {
      const payload = parseEvent<{
        unreadCount: number;
        criticalCount: number;
        items: RiskNotification[];
      }>(event);
      if (!payload || cancelled) return;
      setUnreadCount(payload.unreadCount);
      setCriticalCount(payload.criticalCount);
      acceptIncoming(payload.items, initializedRef.current);
      initializedRef.current = true;
    });
    source.addEventListener("notification", (event) => {
      const payload = parseEvent<RiskNotification>(event);
      if (!payload || cancelled) return;
      setUnreadCount((count) => count + (payload.isRead ? 0 : 1));
      if (payload.severity === "critical" && !payload.resolvedAt) {
        setCriticalCount((count) => count + 1);
      }
      acceptIncoming([payload], true);
    });

    const fallback = window.setInterval(() => {
      if (document.visibilityState === "visible" && source.readyState !== EventSource.OPEN) {
        load().catch(() => undefined);
      }
    }, 15000);

    return () => {
      cancelled = true;
      source.close();
      window.clearInterval(fallback);
      if (thoughtTimerRef.current) window.clearTimeout(thoughtTimerRef.current);
    };
  }, [acceptIncoming, load]);

  const markRead = useCallback(async (item: RiskNotification) => {
    if (item.isRead) return;
    try {
      const result = await api<NotificationReadResult>(
        `/api/v1/notifications/${item.id}/read`,
        { method: "POST" },
      );
      setUnreadCount(result.unreadCount);
      setItems((previous) =>
        sortNotifications(
          previous.map((candidate) =>
            candidate.id === item.id
              ? (result.notification ?? { ...candidate, isRead: true })
              : candidate,
          ),
        ),
      );
      if (item.severity === "critical") {
        setCriticalCount((count) => Math.max(0, count - 1));
      }
    } catch {
      /* The stream/list will reconcile on the next successful sync. */
    }
  }, []);

  const openItem = useCallback(
    (item: RiskNotification) => {
      void markRead(item);
      setThought(null);
      setOpen(false);
      if (item.customerId) onOpenCustomer(item.customerId, item.riskLevel);
    },
    [markRead, onOpenCustomer],
  );

  const markAll = useCallback(async () => {
    try {
      const result = await api<NotificationReadResult>("/api/v1/notifications/read-all", {
        method: "POST",
      });
      setUnreadCount(result.unreadCount);
      setCriticalCount(0);
      setItems((previous) =>
        sortNotifications(previous.map((item) => ({ ...item, isRead: true }))),
      );
      setThought(null);
    } catch {
      /* Keep the current list; the next sync will retry. */
    }
  }, []);

  const visibleItems = useMemo(
    () =>
      items.filter(
        (item) => item.score == null || item.score >= minimumScore || item.severity === "critical",
      ),
    [items, minimumScore],
  );
  const mascotPose = criticalCount > 0 ? "business" : "calm";

  return (
    <section className="realtime-alerts" aria-label="Realtime-уведомления о риске">
      <AnimatePresence initial={false}>
        {thought && !open && (
          <motion.div
            key={thought.id}
            className={`alerts-thought alerts-severity-${thought.severity}`}
            role="status"
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ default: springEmphasized, opacity: springExEffects }}
          >
            <span className="alerts-thought-tail" aria-hidden="true" />
            <button
              type="button"
              className="alerts-thought-main"
              onClick={() => openItem(thought)}
            >
              <strong>{thoughtPrefix(thought)}</strong>
              <span>
                {thought.customerEmail ? `${thought.customerEmail}: ` : ""}
                {thought.message}
              </span>
              <small>
                {thought.score != null ? `скор ${integer(thought.score)} · ` : ""}
                под риском {money(thought.estimatedLoss)}
              </small>
            </button>
            <button
              type="button"
              className="alerts-mini-close"
              onClick={() => setThought(null)}
              aria-label="Скрыть мысль Aéza-тян"
            >
              <IconClose />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {open && (
          <motion.aside
            className="alerts-panel"
            role="dialog"
            aria-label="Мысли Aéza-тян и realtime-события риска"
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ default: springEmphasized, opacity: springExEffects }}
          >
            <header className="alerts-panel-head">
              <span className="alerts-avatar" aria-hidden="true">
                <MascotImage pose={mascotPose} className="alerts-mascot-img" />
              </span>
              <div>
                <strong>Мысли Aéza-тян</strong>
                <span>
                  <i className={`alerts-live-dot${connected ? " is-live" : ""}`} aria-hidden="true" />
                  {connected ? "мониторинг в реальном времени" : "переподключение…"}
                </span>
              </div>
              <button
                type="button"
                className="alerts-icon-button"
                onClick={() => setOpen(false)}
                aria-label="Закрыть уведомления"
              >
                <IconClose />
              </button>
            </header>

            <div className="alerts-controls">
              <span>
                Критично от <strong>80</strong> · высокий риск от <strong>65</strong>
              </span>
              <label>
                Показывать от
                <select
                  value={minimumScore}
                  onChange={(event) => setMinimumScore(Number(event.target.value))}
                  aria-label="Минимальный скор уведомлений"
                >
                  <option value={0}>0</option>
                  <option value={65}>65</option>
                  <option value={80}>80</option>
                  <option value={90}>90</option>
                </select>
              </label>
            </div>

            <div className="alerts-list">
              {visibleItems.length === 0 ? (
                <div className="alerts-empty">
                  <MascotImage pose="calm" className="alerts-empty-img" />
                  <strong>Сейчас тихо.</strong>
                  <span>Я слежу за ростом скора, ожиданиями оплаты и деньгами под угрозой.</span>
                </div>
              ) : (
                visibleItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`alerts-item alerts-severity-${item.severity}${item.isRead ? " is-read" : ""}`}
                    onClick={() => openItem(item)}
                  >
                    <span className="alerts-item-top">
                      <span className="alerts-severity">{SEVERITY_LABEL[item.severity]}</span>
                      <time>{relativeTime(item.firstSeenAt)}</time>
                    </span>
                    <strong>{item.title}</strong>
                    <span>{item.message}</span>
                    <small>
                      {item.customerEmail ?? "Весь портфель"}
                      {item.score != null ? ` · скор ${integer(item.score)}` : ""} · {money(item.estimatedLoss)}
                      {item.requiredTopUp ? ` · пополнить ${money(item.requiredTopUp)}` : ""}
                      {item.resolvedAt ? " · уже разрешено" : ""}
                    </small>
                  </button>
                ))
              )}
            </div>

            <footer className="alerts-panel-foot">
              <span>{integer(unreadCount)} непрочитанных</span>
              <button type="button" onClick={() => void markAll()} disabled={unreadCount === 0}>
                <IconCheck /> Прочитать все
              </button>
            </footer>
          </motion.aside>
        )}
      </AnimatePresence>

      <motion.button
        type="button"
        className={`alerts-fab${criticalCount > 0 ? " has-critical" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={`Уведомления Aéza-тян. Непрочитанных: ${unreadCount}, критических: ${criticalCount}`}
        whileHover={{ y: -2, scale: 1.03 }}
        whileTap={{ scale: 0.94 }}
        transition={springSnappy}
      >
        <span className="alerts-fab-mascot" aria-hidden="true">
          <MascotImage pose={mascotPose} className="alerts-mascot-img" />
        </span>
        <span className="alerts-fab-bell" aria-hidden="true">
          <IconBell />
        </span>
        {unreadCount > 0 && <span className="alerts-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </motion.button>
    </section>
  );
}
