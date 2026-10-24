import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type {
  Customer,
  CustomerList as CustomerListData,
  ModelSettings,
  RiskLevel,
  SortKey,
  SortOrder,
  Summary,
} from "./types";
import { RISK_LABELS } from "./types";
import { api, ApiError } from "./api";
import { customerWord, integer, money as moneyFormat, money, timeLabel, todayLabel } from "./format";
import { useTheme } from "./theme";
import { fadeRise, pageVariants, springEmphasized, springSnappy } from "./motion";
import { CustomerList } from "./components/CustomerList";
import { RiskDonut } from "./components/RiskDonut";
import { ForecastChart } from "./components/ForecastChart";
import { KpiCards, KpiSkeletons } from "./components/KpiCards";
import { WeightControls } from "./components/WeightControls";
import { AnimatedNumber } from "./components/AnimatedNumber";
import {
  MobileNav,
  Sidebar,
  Snackbar,
  Topbar,
  type SectionId,
  type ToastState,
  type UploadPhase,
} from "./components/Chrome";
import { IconArrowRight, IconArrowUpRight, IconChevron, IconUpload } from "./icons";

const PAGE_SIZE = 50;
const PAGE_ORDER: SectionId[] = ["overview", "customers", "model"];

type SaveStatus = "synced" | "saving" | "error";

function pageFromHash(): SectionId {
  const raw = window.location.hash.replace("#", "");
  return (PAGE_ORDER as string[]).includes(raw) ? (raw as SectionId) : "overview";
}

/* ---------------- Overview: today's retention queue ---------------- */

function TodayQueue({
  items,
  total,
  loading,
  onOpen,
  onShowAll,
}: {
  items: Customer[];
  total: number;
  loading: boolean;
  onOpen: (id: string) => void;
  onShowAll: () => void;
}) {
  return (
    <motion.section
      className="panel queue-panel"
      variants={fadeRise}
      custom={0.16}
      initial="hidden"
      animate="show"
      aria-label="Очередь на сегодня"
    >
      <div className="panel-heading queue-heading">
        <div className="section-heading-copy">
          <span className="eyebrow">Сначала — эти клиенты</span>
          <h2>Очередь на сегодня</h2>
          <p>Высокий риск по убыванию score. Клик откроет карточку на странице «Клиенты».</p>
        </div>
        <motion.button
          type="button"
          className="button button-tonal button-small"
          onClick={onShowAll}
          whileTap={{ scale: 0.96 }}
          transition={springSnappy}
        >
          Все с высоким риском{total ? ` · ${integer(total)}` : ""} <IconArrowRight />
        </motion.button>
      </div>

      {loading && items.length === 0 ? (
        <div className="queue-skeletons" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="row-skeleton">
              <span className="skeleton skeleton-avatar" />
              <span className="skeleton skeleton-line skeleton-line-wide" />
              <span className="skeleton skeleton-pill" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="table-state queue-empty">
          <strong>Клиентов с высоким риском сейчас нет</strong>
          <span>Очередь пуста — можно заняться плановыми контактами среднего риска.</span>
        </div>
      ) : (
        <div className="queue-list" role="list">
          {items.map((customer, index) => (
            <motion.button
              key={customer.id}
              type="button"
              role="listitem"
              className="queue-row"
              onClick={() => onOpen(customer.id)}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...springEmphasized, delay: 0.05 * index }}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.99 }}
              aria-label={`Открыть клиента ${customer.email} на странице клиентов`}
            >
              <span className="queue-rank" aria-hidden="true">
                {index + 1}
              </span>
              <span className="client-avatar client-avatar-high" aria-hidden="true">
                {(customer.email?.trim()?.[0] || "?").toUpperCase()}
              </span>
              <span className="queue-copy">
                <span className="client-email" title={customer.email}>
                  {customer.email}
                </span>
                <span className="queue-reason">
                  {customer.reasons?.[0] || "Высокий риск по совокупности сигналов"}
                </span>
              </span>
              <span className="queue-side">
                <strong>{money(customer.estimatedLoss)}</strong>
                <span>под риском · 90 дней</span>
              </span>
              <span className="risk-pill risk-pill-high">
                {`${RISK_LABELS.high} · ${customer.score ?? "—"}`}
              </span>
              <span className="queue-chevron" aria-hidden="true">
                <IconChevron />
              </span>
            </motion.button>
          ))}
        </div>
      )}
    </motion.section>
  );
}

/* ---------------- Model page: live effect strip ---------------- */

function ModelImpact({ summary }: { summary: Summary }) {
  const segments: { key: RiskLevel; value: number }[] = [
    { key: "high", value: summary.highRisk },
    { key: "medium", value: summary.mediumRisk },
    { key: "low", value: summary.lowRisk },
    { key: "unrated", value: summary.unratedCount },
  ];
  return (
    <motion.section
      className="panel impact-panel"
      variants={fadeRise}
      custom={0.06}
      initial="hidden"
      animate="show"
      aria-label="Текущий эффект модели"
    >
      <div className="impact-head">
        <div>
          <span className="eyebrow">Эффект сейчас</span>
          <h2>Распределение после пересчёта</h2>
        </div>
        <div className="impact-loss">
          <span>Выручка под риском</span>
          <AnimatedNumber value={summary.estimatedLoss} format={moneyFormat} />
        </div>
      </div>
      <div className="impact-bar" aria-hidden="true">
        {segments.map((segment) => (
          <motion.span
            key={segment.key}
            className={`impact-seg impact-seg-${segment.key}`}
            initial={false}
            animate={{ flexGrow: Math.max(segment.value, 0.0001) }}
            transition={springEmphasized}
          />
        ))}
      </div>
      <div className="impact-stats">
        {segments.map((segment) => (
          <div key={segment.key} className="impact-stat">
            <span>
              <span className={`risk-dot risk-dot-${segment.key}`} aria-hidden="true" />{" "}
              {RISK_LABELS[segment.key]}
            </span>
            <AnimatedNumber value={segment.value} format={integer} />
          </div>
        ))}
      </div>
      <p className="panel-hint">
        Двигайте весы ниже — распределение и выручка пересчитаются прямо на этой странице.
      </p>
    </motion.section>
  );
}

/* ---------------- Dashboard shell + pages ---------------- */

export function Dashboard() {
  const { theme, toggleTheme } = useTheme();

  const [username, setUsername] = useState("Аналитик");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [customers, setCustomers] = useState<CustomerListData>({ items: [], total: 0 });
  const [topQueue, setTopQueue] = useState<CustomerListData>({ items: [], total: 0 });
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [sort, setSort] = useState<SortKey>("score");
  const [order, setOrder] = useState<SortOrder>("desc");
  const [risk, setRisk] = useState<RiskLevel | "">("");
  const [offset, setOffset] = useState(0);
  const [direction, setDirection] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState<SectionId>(() => pageFromHash());
  const [pageDirection, setPageDirection] = useState(1);
  const [connectionError, setConnectionError] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState("только что");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("synced");
  const [toast, setToast] = useState<ToastState | null>(null);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [dragActive, setDragActive] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const firstPageRender = useRef(true);
  const refreshPromise = useRef<Promise<void> | null>(null);
  const pendingWeights = useRef<Record<string, number>>({});
  const saveTimer = useRef<number | null>(null);
  const savePromise = useRef<Promise<void> | null>(null);
  const toastTimer = useRef<number | null>(null);
  const dragCounter = useRef(0);
  const summaryRef = useRef<Summary | null>(null);
  const signatureRef = useRef<string>("");

  const showToast = useCallback((message: string, persistent = false) => {
    setToast({ id: Date.now(), message, persistent });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    if (!persistent) {
      toastTimer.current = window.setTimeout(() => setToast(null), 4200);
    }
  }, []);

  /* ---------------- page routing (one nav item = one page) ---------------- */

  const goToPage = useCallback((next: SectionId) => {
    if (next === pageRef.current) return;
    setPageDirection(
      PAGE_ORDER.indexOf(next) >= PAGE_ORDER.indexOf(pageRef.current) ? 1 : -1,
    );
    setPage(next);
    if (window.location.hash !== `#${next}`) {
      window.history.pushState(null, "", `#${next}`);
    }
  }, []);

  // Back/forward buttons and manual hash edits.
  useEffect(() => {
    const onHash = () => {
      const next = pageFromHash();
      if (next !== pageRef.current) {
        setPageDirection(
          PAGE_ORDER.indexOf(next) >= PAGE_ORDER.indexOf(pageRef.current) ? 1 : -1,
        );
        setPage(next);
      }
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, []);

  // Page turns start from the top; focus moves to the new heading when it
  // actually mounts (AnimatePresence mode="wait" mounts it after the exit).
  const focusPendingRef = useRef(false);
  useEffect(() => {
    if (firstPageRender.current) {
      firstPageRender.current = false;
      return;
    }
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    focusPendingRef.current = true;
  }, [page]);

  const setHeadingRef = useCallback((el: HTMLHeadingElement | null) => {
    pageHeadingRef.current = el;
    if (el && focusPendingRef.current) {
      focusPendingRef.current = false;
      el.focus({ preventScroll: true });
    }
  }, []);

  /* ---------------- data loading (same flow as the legacy client) ---------------- */

  const refresh = useCallback(
    async (
      includeSettings = false,
      overrides?: Partial<{ sort: SortKey; order: SortOrder; risk: RiskLevel | ""; offset: number }>,
    ): Promise<void> => {
      if (refreshPromise.current) {
        await refreshPromise.current;
        if (includeSettings) return refresh(true, overrides);
        return;
      }
      const effective = {
        sort: overrides?.sort ?? sort,
        order: overrides?.order ?? order,
        risk: overrides?.risk ?? risk,
        offset: overrides?.offset ?? offset,
      };
      const run = (async () => {
        const params = new URLSearchParams({
          sort: effective.sort,
          order: effective.order,
          limit: String(PAGE_SIZE),
          offset: String(effective.offset),
        });
        if (effective.risk) params.set("risk", effective.risk);
        const queueParams = new URLSearchParams({
          risk: "high",
          sort: "score",
          order: "desc",
          limit: "5",
          offset: "0",
        });
        const requests: [
          Promise<Summary>,
          Promise<CustomerListData>,
          Promise<CustomerListData>,
          Promise<ModelSettings | null>,
        ] = [
          api<Summary>("/api/v1/analytics/summary"),
          api<CustomerListData>(`/api/v1/customers?${params}`),
          api<CustomerListData>(`/api/v1/customers?${queueParams}`),
          includeSettings ? api<ModelSettings>("/api/v1/model/settings") : Promise.resolve(null),
        ];
        const [summaryData, firstPage, queueData, freshSettings] = await Promise.all(requests);
        let customerData = firstPage;
        let nextOffset = effective.offset;
        if (effective.offset > 0 && effective.offset >= customerData.total) {
          nextOffset = customerData.total
            ? Math.floor((customerData.total - 1) / PAGE_SIZE) * PAGE_SIZE
            : 0;
          params.set("offset", String(nextOffset));
          customerData = await api<CustomerListData>(`/api/v1/customers?${params}`);
          setOffset(nextOffset);
        }

        // Avoid pointless re-renders (and re-animations) on identical polls.
        const signature = JSON.stringify([summaryData, customerData, queueData, freshSettings]);
        if (signature !== signatureRef.current) {
          signatureRef.current = signature;
          const previous = summaryRef.current;
          if (
            previous &&
            (["customerCount", "highRisk", "mediumRisk", "lowRisk", "estimatedLoss", "atRiskServices"] as const).some(
              (key) => previous[key] !== summaryData[key],
            )
          ) {
            setLiveMessage(
              `Данные обновлены. Клиентов: ${integer(summaryData.customerCount)}; высокий риск: ${integer(summaryData.highRisk)}; потенциальные потери: ${moneyFormat(summaryData.estimatedLoss)}.`,
            );
          }
          summaryRef.current = summaryData;
          setSummary(summaryData);
          setCustomers(customerData);
          setTopQueue(queueData);
          if (freshSettings) setSettings(freshSettings);
        }
        setLastUpdated(`Обновлено ${timeLabel()}`);
        setConnectionError(false);
        setLoadError(null);
        setInitialLoading(false);
      })();
      refreshPromise.current = run;
      try {
        await run;
      } finally {
        refreshPromise.current = null;
      }
    },
    [sort, order, risk, offset],
  );

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const handleRefreshError = useCallback(
    (error: unknown, context: string) => {
      if (error instanceof ApiError && error.status === 401) return;
      const message = error instanceof Error ? error.message : "Неизвестная ошибка";
      setConnectionError(true);
      setInitialLoading(false);
      if (!summaryRef.current) setLoadError(message);
      showToast(`${context}: ${message}`, true);
    },
    [showToast],
  );

  /* ---------------- startup + polling ---------------- */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await api<{ username: string }>("/api/v1/auth/me");
        if (cancelled) return;
        setUsername(me.username);
        await refreshRef.current(true);
      } catch (error) {
        if (!cancelled) handleRefreshError(error, "Не удалось загрузить рабочее пространство");
      }
    })();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !refreshPromise.current) {
        refreshRef.current(false).catch((error) =>
          handleRefreshError(error, "Не удалось обновить данные"),
        );
      }
    }, 10000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshRef.current(false).catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- weights ---------------- */

  const flushWeightSaves = useCallback(async (): Promise<void> => {
    if (savePromise.current || Object.keys(pendingWeights.current).length === 0) return;
    const changes = pendingWeights.current;
    pendingWeights.current = {};
    const run = (async () => {
      try {
        const updated = await api<ModelSettings>("/api/v1/model/settings", {
          method: "PATCH",
          body: JSON.stringify({ weights: changes }),
        });
        // Preserve any newer optimistic edits made while the request flew.
        setSettings((previous) =>
          previous
            ? { ...updated, weights: { ...updated.weights, ...previous.weights, ...pendingWeights.current } }
            : updated,
        );
        signatureRef.current = "";
        setSaveStatus("synced");
        await refreshRef.current(false);
      } catch (error) {
        setSaveStatus("error");
        if (error instanceof ApiError && error.status !== 401) {
          showToast(`Не удалось сохранить коэффициент: ${error.message}`, true);
        }
      } finally {
        savePromise.current = null;
        if (Object.keys(pendingWeights.current).length > 0) {
          void flushWeightSaves();
        }
      }
    })();
    savePromise.current = run;
    await run;
  }, [showToast]);

  const handleWeightChange = useCallback(
    (key: string, value: number) => {
      const rounded = Math.round(value);
      pendingWeights.current[key] = rounded;
      setSettings((previous) =>
        previous ? { ...previous, weights: { ...previous.weights, [key]: rounded } } : previous,
      );
      setSaveStatus("saving");
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flushWeightSaves(), 320);
    },
    [flushWeightSaves],
  );

  /* ---------------- table controls ---------------- */

  const reloadWith = useCallback(
    (overrides: Partial<{ sort: SortKey; order: SortOrder; risk: RiskLevel | ""; offset: number }>, context: string) => {
      refresh(false, overrides).catch((error) => handleRefreshError(error, context));
    },
    [refresh, handleRefreshError],
  );

  const handleSort = useCallback(
    (next: SortKey) => {
      setDirection(1);
      if (sort === next) {
        const nextOrder: SortOrder = order === "asc" ? "desc" : "asc";
        setOrder(nextOrder);
        setOffset(0);
        setExpandedId(null);
        reloadWith({ order: nextOrder, offset: 0 }, "Не удалось отсортировать клиентов");
      } else {
        setSort(next);
        setOrder("desc");
        setOffset(0);
        setExpandedId(null);
        reloadWith({ sort: next, order: "desc", offset: 0 }, "Не удалось отсортировать клиентов");
      }
    },
    [sort, order, reloadWith],
  );

  const handleRiskChange = useCallback(
    (next: RiskLevel | "") => {
      setRisk(next);
      setOffset(0);
      setExpandedId(null);
      setDirection(1);
      reloadWith({ risk: next, offset: 0 }, "Не удалось отфильтровать клиентов");
    },
    [reloadWith],
  );

  const handlePrevious = useCallback(() => {
    const nextOffset = Math.max(0, offset - PAGE_SIZE);
    setDirection(-1);
    setOffset(nextOffset);
    setExpandedId(null);
    reloadWith({ offset: nextOffset }, "Не удалось открыть страницу клиентов");
  }, [offset, reloadWith]);

  const handleNext = useCallback(() => {
    const nextOffset = offset + PAGE_SIZE;
    setDirection(1);
    setOffset(nextOffset);
    setExpandedId(null);
    reloadWith({ offset: nextOffset }, "Не удалось открыть страницу клиентов");
  }, [offset, reloadWith]);

  const showHighRisk = useCallback(() => {
    handleRiskChange("high");
    goToPage("customers");
  }, [handleRiskChange, goToPage]);

  // Donut on the overview navigates into the filtered work queue.
  const handleOverviewRiskSelect = useCallback(
    (next: RiskLevel | "") => {
      handleRiskChange(next);
      if (next) goToPage("customers");
    },
    [handleRiskChange, goToPage],
  );

  const openFromQueue = useCallback(
    (id: string) => {
      setSort("score");
      setOrder("desc");
      setRisk("high");
      setOffset(0);
      setDirection(1);
      setExpandedId(id);
      goToPage("customers");
      reloadWith(
        { sort: "score", order: "desc", risk: "high", offset: 0 },
        "Не удалось открыть клиента",
      );
    },
    [goToPage, reloadWith],
  );

  /* ---------------- snapshot upload (+ drag & drop) ---------------- */

  const uploadSnapshot = useCallback(
    async (file: File) => {
      if (file.size > 32 * 1024 * 1024) {
        showToast("Файл больше допустимого размера 32 МБ.", true);
        return;
      }
      setUploadPhase("loading");
      try {
        const contents = JSON.parse(await file.text()) as Record<string, unknown>;
        const accounts = (contents.accounts ?? contents.users) as unknown;
        if (
          Array.isArray(accounts) &&
          accounts.length === 0 &&
          !window.confirm("В снимке нет аккаунтов. Заменить текущие данные пустым снимком?")
        ) {
          setUploadPhase("idle");
          return;
        }
        const result = await api<{ accountCount: number }>("/api/v1/source/snapshot", {
          method: "PUT",
          body: JSON.stringify(contents),
        });
        signatureRef.current = "";
        setUploadPhase("success");
        window.setTimeout(() => setUploadPhase("idle"), 1800);
        showToast(`Снимок загружен · ${integer(result.accountCount)} аккаунтов`);
        setOffset(0);
        setExpandedId(null);
        await refresh(true, { offset: 0 });
      } catch (error) {
        setUploadPhase("idle");
        if (error instanceof ApiError && error.status === 401) return;
        const message = error instanceof Error ? error.message : "Неизвестная ошибка";
        showToast(`Не удалось загрузить снимок: ${message}`, true);
      }
    },
    [refresh, showToast],
  );

  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragCounter.current += 1;
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setDragActive(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragCounter.current = 0;
      setDragActive(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) void uploadSnapshot(file);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [uploadSnapshot]);

  /* ---------------- auth ---------------- */

  const logout = useCallback(async () => {
    try {
      await api("/api/v1/auth/logout", { method: "POST" });
    } catch (error) {
      if (error instanceof ApiError && error.status !== 401) {
        showToast(`Не удалось завершить сессию: ${error.message}`, true);
      }
    } finally {
      window.location.replace("/login");
    }
  }, [showToast]);

  /* ---------------- pages ---------------- */

  const pageFooter = (
    <footer className="page-footer">
      <span>Контур · Аналитика удержания</span>
      <span>Источник: евроценты · Панель: евро</span>
    </footer>
  );

  const overviewPage = (
    <>
      <section className="page-heading">
        <div className="page-heading-copy">
          <span className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            Центр удержания
          </span>
          <h1 ref={setHeadingRef} tabIndex={-1}>
            Риск оттока<span className="heading-period">.</span>
          </h1>
          <p>
            Приоритеты команды, причины риска и выручка под угрозой — в одном
            рабочем пространстве, которое пересчитывается на лету.
          </p>
        </div>
        <div className="heading-side">
          <span className="date-label">{todayLabel()}</span>
          <a href="/api/v1/docs" target="_blank" rel="noreferrer" className="docs-link">
            API и документация <IconArrowUpRight />
          </a>
        </div>
      </section>

      {summary ? (
        <KpiCards summary={summary} onShowHighRisk={showHighRisk} />
      ) : (
        <KpiSkeletons />
      )}

      <section className="overview-analytics" aria-label="Сводная аналитика">
        <motion.article
          className="panel risk-panel"
          variants={fadeRise}
          custom={0.1}
          initial="hidden"
          animate="show"
        >
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Сегменты</span>
              <h2>Уровень риска</h2>
            </div>
            <span className="panel-meta">Сейчас</span>
          </div>
          {summary ? (
            <RiskDonut summary={summary} activeRisk={risk} onSelectRisk={handleOverviewRiskSelect} />
          ) : (
            <div className="donut-skeleton skeleton" aria-hidden="true" />
          )}
          <p className="panel-hint">
            Зажмите и ведите по легенде, отпустите на сегменте — откроется отфильтрованная
            очередь клиентов.
          </p>
        </motion.article>

        <motion.article
          className="panel chart-panel"
          variants={fadeRise}
          custom={0.16}
          initial="hidden"
          animate="show"
        >
          <div className="panel-heading">
            <div>
              <span className="eyebrow">По срокам услуг</span>
              <h2>Продления на горизонте 30 дней</h2>
            </div>
            <span className="panel-meta">Календарный ориентир</span>
          </div>
          <div className="chart-legend" aria-hidden="true">
            <span>
              <i className="fact-swatch" />
              Сейчас
            </span>
            <span>
              <i className="forecast-swatch" />
              К сроку
            </span>
          </div>
          <ForecastChart forecast={summary?.churnForecast} />
          <p id="forecastDescription" className="chart-note">
            Число услуг, ожидающих оплаты сейчас и приближающихся к окончанию. Это
            календарный ориентир, не вероятность оттока.
          </p>
        </motion.article>
      </section>

      <TodayQueue
        items={topQueue.items}
        total={topQueue.total}
        loading={initialLoading}
        onOpen={openFromQueue}
        onShowAll={showHighRisk}
      />
      {pageFooter}
    </>
  );

  const customersPage = (
    <>
      <section className="page-heading page-heading-compact">
        <div className="page-heading-copy">
          <span className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            Рабочее пространство
          </span>
          <h1 ref={setHeadingRef} tabIndex={-1}>
            Клиенты<span className="heading-period">.</span>
          </h1>
          <p>Очередь удержания по текущему снимку: сортируйте, фильтруйте и открывайте карточки прямо в списке.</p>
        </div>
        <div className="heading-side">
          <span className="date-label">{todayLabel()}</span>
          <span className="panel-meta">
            {integer(customers.total)} {customerWord(customers.total)} в выборке
          </span>
        </div>
      </section>

      <motion.section
        className="panel table-panel"
        variants={fadeRise}
        custom={0.06}
        initial="hidden"
        animate="show"
        aria-label="Список клиентов"
      >
        <CustomerList
          items={customers.items}
          total={customers.total}
          sort={sort}
          order={order}
          onSort={handleSort}
          risk={risk}
          onRiskChange={handleRiskChange}
          offset={offset}
          pageSize={PAGE_SIZE}
          direction={direction}
          onPrevious={handlePrevious}
          onNext={handleNext}
          expandedId={expandedId}
          onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
          onToast={showToast}
          initialLoading={initialLoading}
          loadError={loadError}
          onRetry={() =>
            refresh(true).catch((error) =>
              handleRefreshError(error, "Не удалось загрузить данные"),
            )
          }
        />
        <p className="table-footnote">
          Оценка по текущему снимку · горизонт потерь — три месяца ·{" "}
          {integer(customers.total)} {customerWord(customers.total)} в выборке
        </p>
      </motion.section>
      {pageFooter}
    </>
  );

  const modelPage = (
    <>
      <section className="page-heading page-heading-compact">
        <div className="page-heading-copy">
          <span className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            Настройка приоритетов
          </span>
          <h1 ref={setHeadingRef} tabIndex={-1}>
            Модель риска<span className="heading-period">.</span>
          </h1>
          <p>Веса сигналов объяснимой эвристики. Изменения сохраняются автоматически и сразу пересчитывают все страницы.</p>
        </div>
        <div className="heading-side">
          <span className="date-label">{todayLabel()}</span>
          <span className={`saved-status saved-${saveStatus}`} role="status" aria-live="polite">
            <motion.i
              aria-hidden="true"
              animate={
                saveStatus === "saving"
                  ? { scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }
                  : { scale: 1, opacity: 1 }
              }
              transition={saveStatus === "saving" ? { repeat: Infinity, duration: 0.9 } : springSnappy}
            />
            <span>
              {saveStatus === "saving"
                ? "Сохраняем…"
                : saveStatus === "error"
                  ? "Не сохранено"
                  : "Синхронизировано"}
            </span>
          </span>
        </div>
      </section>

      {summary ? <ModelImpact summary={summary} /> : <KpiSkeletons />}

      <motion.section
        className="panel model-panel"
        variants={fadeRise}
        custom={0.12}
        initial="hidden"
        animate="show"
        aria-label="Веса сигналов"
      >
        <div className="panel-heading model-heading">
          <div className="section-heading-copy">
            <span className="eyebrow">Сигналы и веса</span>
            <h2>Как рассчитывается риск</h2>
            <p>
              Измените вклад сигнала — оценки, порядок клиентов и выручка под риском
              пересчитаются и сохранятся автоматически.
            </p>
          </div>
        </div>
        {settings ? (
          <WeightControls settings={settings} onWeightChange={handleWeightChange} />
        ) : (
          <div className="weight-skeletons" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div key={index} className="weight-item">
                <span className="skeleton skeleton-line skeleton-line-narrow" />
                <span className="skeleton skeleton-line" />
              </div>
            ))}
          </div>
        )}
      </motion.section>
      {pageFooter}
    </>
  );

  /* ---------------- render ---------------- */

  return (
    <div className="app-shell">
      <a className="skip-link" href="#mainContent">
        Перейти к содержимому
      </a>
      <Sidebar
        activeSection={page}
        onNavigate={goToPage}
        customerCount={summary ? integer(summary.customerCount) : "—"}
        username={username}
        connectionError={connectionError}
        onLogout={() => void logout()}
      />

      <main className="main-content" id="mainContent" tabIndex={-1}>
        <Topbar
          sectionLabel={
            { overview: "Обзор", customers: "Клиенты", model: "Модель риска" }[page]
          }
          theme={theme}
          onToggleTheme={toggleTheme}
          connectionError={connectionError}
          lastUpdated={lastUpdated}
          uploadPhase={uploadPhase}
          onUploadClick={() => fileInputRef.current?.click()}
          fileInputRef={fileInputRef}
          onFileSelected={(file) => void uploadSnapshot(file)}
          onLogout={() => void logout()}
        />

        <AnimatePresence mode="wait" custom={pageDirection} initial={false}>
          <motion.div
            key={page}
            className="page-view"
            custom={pageDirection}
            variants={pageVariants}
            initial="enter"
            animate="center"
            exit="exit"
          >
            {page === "overview" ? overviewPage : page === "customers" ? customersPage : modelPage}
          </motion.div>
        </AnimatePresence>
      </main>

      <MobileNav activeSection={page} onNavigate={goToPage} />
      <Snackbar toast={toast} onClose={() => setToast(null)} />

      <AnimatePresence>
        {dragActive && (
          <motion.div
            className="drop-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            aria-hidden="true"
          >
            <motion.div
              className="drop-card"
              initial={{ scale: 0.92, y: 16 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 8 }}
              transition={springEmphasized}
            >
              <span className="drop-icon">
                <IconUpload />
              </span>
              <strong>Отпустите JSON-снимок</strong>
              <span>Аккаунты, услуги и транзакции заменят текущий снимок атомарно</span>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </div>
    </div>
  );
}
