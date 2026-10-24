import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type {
  Customer,
  CustomerList as CustomerListData,
  ModelSettings,
  RescueQueueData,
  RiskLevel,
  SortKey,
  SortOrder,
  Summary,
} from "./types";
import { RISK_LABELS } from "./types";
import { api, ApiError } from "./api";
import { customerWord, integer, money as moneyFormat, money, todayLabel } from "./format";
import { useTheme } from "./theme";
import { fadeRise, pageVariants, springEmphasized, springSnappy } from "./motion";
import { CustomerList, type SavedView } from "./components/CustomerList";
import { RiskDonut } from "./components/RiskDonut";
const RealtimeAlerts = lazy(() =>
  import("./components/RealtimeAlerts").then((m) => ({ default: m.RealtimeAlerts })),
);
const RescueQueue = lazy(() =>
  import("./components/RescueQueue").then((m) => ({ default: m.RescueQueue })),
);
const DevPanel = lazy(() =>
  import("./components/DevPanel").then((m) => ({ default: m.DevPanel })),
);
const RiskStream = lazy(() =>
  import("./components/RiskStream").then((m) => ({ default: m.RiskStream })),
);
import { KpiCards, KpiSkeletons } from "./components/KpiCards";
import { WeightControls } from "./components/WeightControls";
const RiskBars = lazy(() =>
  import("./components/RiskBars").then((m) => ({ default: m.RiskBars })),
);
import { WhatIfPanel } from "./components/WhatIf";
import {
  DataQuality,
  RevenueCalculator,
  ScoreHistory,
  type HistoryPoint,
} from "./components/Insights";
import { lossByLevel, simulateWeights, type LevelCounts } from "./simulate";
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
import { IconArrowRight, IconArrowUpRight, IconUpload } from "./icons";
import { MascotStage, MascotTip, ShapeLoader } from "./components/Brand";

const PAGE_SIZE = 50;
const PAGE_ORDER: SectionId[] = ["overview", "customers", "model", "live"];

function PanelSkeleton() {
  return (
    <div className="panel panel-skeleton" aria-hidden="true">
      <ShapeLoader />
      <span className="skeleton skeleton-line skeleton-line-narrow" />
      <span className="skeleton skeleton-line skeleton-line-wide" />
      <span className="skeleton skeleton-line" />
    </div>
  );
}

type SaveStatus = "synced" | "saving" | "error";

/**
 * Browser-local product memory: named queue views and the portfolio
 * history. The API has no persistence for either yet (see REVIEW.md —
 * server roadmap), so these live in localStorage and are labelled as
 * local in the UI instead of pretending to be shared product data.
 */
const VIEWS_KEY = "kontur.savedViews.v1";
const HISTORY_KEY = "kontur.portfolioHistory.v1";

function loadJSON(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function loadSavedViews(): SavedView[] {
  const raw = loadJSON(VIEWS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (value): value is SavedView =>
      Boolean(value && typeof value === "object" && "id" in value && "name" in value),
  );
}

function loadHistory(): HistoryPoint[] {
  const raw = loadJSON(HISTORY_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (value): value is HistoryPoint =>
        Boolean(value && typeof value === "object" && "t" in value && "loss" in value),
    )
    .slice(-60);
}

function storeJSON(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage can be unavailable (private mode) — features degrade quietly */
  }
}

function pageFromHash(): SectionId {
  const raw = window.location.hash.replace("#", "");
  return (PAGE_ORDER as string[]).includes(raw) ? (raw as SectionId) : "overview";
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
  const [rescueQueue, setRescueQueue] = useState<RescueQueueData | null>(null);
  const [customers, setCustomers] = useState<CustomerListData>({ items: [], total: 0 });
  const [overviewRisk, setOverviewRisk] = useState<RiskLevel | "">("");
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [sort, setSort] = useState<SortKey>("score");
  const [order, setOrder] = useState<SortOrder>("desc");
  const [risk, setRisk] = useState<RiskLevel | "">("");
  const [offset, setOffset] = useState(0);
  const [direction, setDirection] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sidebarMode, setSidebarMode] = useState<"expanded" | "rail">(() => {
    try {
      const saved = window.localStorage.getItem("kontur.sidebar.v1");
      if (saved === "rail" || saved === "expanded") return saved;
    } catch {
      /* storage unavailable */
    }
    return window.matchMedia("(max-width: 1280px)").matches ? "rail" : "expanded";
  });
  const [page, setPage] = useState<SectionId>(() => pageFromHash());
  const [pageDirection, setPageDirection] = useState(1);
  const [connectionError, setConnectionError] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("synced");
  const [toast, setToast] = useState<ToastState | null>(null);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [dragActive, setDragActive] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  const [landscapeCustomers, setLandscapeCustomers] = useState<Customer[]>([]);
  const [weightDraft, setWeightDraft] = useState<Record<string, number> | null>(null);
  const [views, setViews] = useState<SavedView[]>(() => loadSavedViews());
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[]>(() => loadHistory());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const firstPageRender = useRef(true);
  const refreshPromise = useRef<Promise<void> | null>(null);
  const toastTimer = useRef<number | null>(null);
  const dragCounter = useRef(0);
  const summaryRef = useRef<Summary | null>(null);
  const signatureRef = useRef<string>("");

  const toggleSidebar = useCallback(() => {
    setSidebarMode((mode) => {
      const next = mode === "rail" ? "expanded" : "rail";
      try {
        window.localStorage.setItem("kontur.sidebar.v1", next);
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);

  const historyRef = useRef<HistoryPoint[]>(loadHistory());

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
        // Top-100 by score powers the 3D landscape, the what-if simulator
        // and the data-quality details. All subset-based widgets say so.
        const landscapeParams = new URLSearchParams({
          sort: "score",
          order: "desc",
          limit: "100",
          offset: "0",
        });
        const requests: [
          Promise<Summary>,
          Promise<RescueQueueData>,
          Promise<CustomerListData>,
          Promise<CustomerListData>,
          Promise<ModelSettings | null>,
        ] = [
          api<Summary>("/api/v1/analytics/summary"),
          api<RescueQueueData>("/api/v1/analytics/rescue-queue?limit=8&minimum_score=65"),
          api<CustomerListData>(`/api/v1/customers?${params}`),
          api<CustomerListData>(`/api/v1/customers?${landscapeParams}`),
          includeSettings ? api<ModelSettings>("/api/v1/model/settings") : Promise.resolve(null),
        ];
        const [summaryData, rescueData, firstPage, landscapeData, freshSettings] =
          await Promise.all(requests);
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
        const signature = JSON.stringify([summaryData, rescueData, customerData, landscapeData, freshSettings]);
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
          setRescueQueue(rescueData);
          setCustomers(customerData);
          setLandscapeCustomers(landscapeData.items);
          // Record a history point only when the portfolio really moved.
          const point: HistoryPoint = {
            t: Date.now(),
            loss: summaryData.estimatedLoss,
            high: summaryData.highRisk,
          };
          const lastPoint = historyRef.current[historyRef.current.length - 1];
          if (!lastPoint || lastPoint.loss !== point.loss || lastPoint.high !== point.high) {
            const nextHistory = [...historyRef.current, point].slice(-60);
            historyRef.current = nextHistory;
            setHistoryPoints(nextHistory);
            storeJSON(HISTORY_KEY, nextHistory);
          }
          if (freshSettings) setSettings(freshSettings);
        }
        setLastUpdatedAt(Date.now());
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

  /* ---------------- weights: draft + what-if, explicit apply ---------------- */

  // Sliders edit a local draft only. The what-if panel simulates its effect
  // instantly; the server applies weights (and re-scores everyone) only on
  // "Применить веса". This replaces the previous autosave-on-change flow.
  useEffect(() => {
    if (settings) setWeightDraft((draft) => draft ?? settings.weights);
  }, [settings]);

  const handleWeightChange = useCallback((key: string, value: number) => {
    const rounded = Math.round(value);
    setWeightDraft((draft) => (draft ? { ...draft, [key]: rounded } : draft));
  }, []);

  const weightsDirty = Boolean(
    settings &&
      weightDraft &&
      Object.keys(weightDraft).some((key) => settings.weights[key] !== weightDraft[key]),
  );

  const simulation = useMemo(
    () =>
      settings && weightDraft
        ? simulateWeights(landscapeCustomers, weightDraft, settings.thresholds)
        : null,
    [landscapeCustomers, settings, weightDraft],
  );
  const landscapeCounts = useMemo<LevelCounts>(() => {
    const counts: LevelCounts = { high: 0, medium: 0, low: 0, unrated: 0 };
    landscapeCustomers.forEach((customer) => {
      counts[customer.riskLevel] += 1;
    });
    return counts;
  }, [landscapeCustomers]);
  const landscapeLoss = useMemo(
    () =>
      landscapeCustomers.reduce(
        (sum, customer) => sum + (Number(customer.estimatedLoss) || 0),
        0,
      ),
    [landscapeCustomers],
  );
  const levelLosses = useMemo(() => lossByLevel(landscapeCustomers), [landscapeCustomers]);

  const applyWeights = useCallback(async (): Promise<void> => {
    if (!settings || !weightDraft) return;
    const changes: Record<string, number> = {};
    Object.entries(weightDraft).forEach(([key, value]) => {
      if (settings.weights[key] !== value) changes[key] = value;
    });
    if (Object.keys(changes).length === 0) return;
    setSaveStatus("saving");
    try {
      const updated = await api<ModelSettings>("/api/v1/model/settings", {
        method: "PATCH",
        body: JSON.stringify({ weights: changes }),
      });
      setSettings(updated);
      setWeightDraft(updated.weights);
      signatureRef.current = "";
      setSaveStatus("synced");
      showToast("Веса применены — сервер пересчитал все оценки");
      await refreshRef.current(false);
    } catch (error) {
      setSaveStatus("error");
      if (error instanceof ApiError && error.status !== 401) {
        showToast(`Не удалось применить веса: ${error.message}`, true);
      }
    }
  }, [settings, showToast, weightDraft]);

  const resetDraft = useCallback(() => {
    if (settings) setWeightDraft(settings.weights);
  }, [settings]);

  /* ---------------- table controls ---------------- */

  const reloadWith = useCallback(
    (overrides: Partial<{ sort: SortKey; order: SortOrder; risk: RiskLevel | ""; offset: number }>, context: string) => {
      refresh(false, overrides).catch((error) => handleRefreshError(error, context));
    },
    [refresh, handleRefreshError],
  );

  const handleSort = useCallback(
    (next: SortKey) => {
      setActiveViewId(null);
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
      setActiveViewId(null);
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

  // Donut selection is inspection, not navigation: it changes the centre
  // and the selected segment on this page only. Moving to the work queue
  // is a separate explicit action below the chart.
  const handleOverviewRiskSelect = useCallback((next: RiskLevel | "") => {
    setOverviewRisk(next);
  }, []);

  const openOverviewRiskSegment = useCallback(() => {
    if (!overviewRisk) return;
    handleRiskChange(overviewRisk);
    goToPage("customers");
  }, [goToPage, handleRiskChange, overviewRisk]);

  // Deep-open used by the 3D landscape and the what-if movers list.
  const openCustomer = useCallback(
    (id: string, level: RiskLevel) => {
      setSort("score");
      setOrder("desc");
      setRisk(level);
      setOffset(0);
      setDirection(1);
      setExpandedId(id);
      goToPage("customers");
      reloadWith(
        { sort: "score", order: "desc", risk: level, offset: 0 },
        "Не удалось открыть клиента",
      );
    },
    [goToPage, reloadWith],
  );

  const openAlertCustomer = useCallback(
    (id: string, level: RiskLevel | null) => {
      openCustomer(id, level ?? "high");
    },
    [openCustomer],
  );

  const refreshFromRealtime = useCallback(() => {
    if (document.visibilityState !== "visible" || refreshPromise.current) return;
    refreshRef.current(false).catch(() => undefined);
  }, []);

  const showUnrated = useCallback(() => {
    handleRiskChange("unrated");
    goToPage("customers");
  }, [goToPage, handleRiskChange]);

  /* ---------------- saved views (browser-local) ---------------- */

  const persistViews = useCallback((nextViews: SavedView[]) => {
    setViews(nextViews);
    storeJSON(VIEWS_KEY, nextViews);
  }, []);

  const handleSaveView = useCallback(
    (name: string) => {
      const view: SavedView = {
        id: `view-${Date.now()}`,
        name,
        risk,
        sort,
        order,
      };
      persistViews([...views, view]);
      setActiveViewId(view.id);
      showToast(`Вид «${name}» сохранён в этом браузере`);
    },
    [order, persistViews, risk, showToast, sort, views],
  );

  const handleApplyView = useCallback(
    (view: SavedView) => {
      setActiveViewId(view.id);
      setSort(view.sort);
      setOrder(view.order);
      setRisk(view.risk);
      setOffset(0);
      setDirection(1);
      setExpandedId(null);
      reloadWith(
        { sort: view.sort, order: view.order, risk: view.risk, offset: 0 },
        "Не удалось применить вид",
      );
    },
    [reloadWith],
  );

  const handleDeleteView = useCallback(
    (id: string) => {
      persistViews(views.filter((view) => view.id !== id));
      setActiveViewId((current) => (current === id ? null : current));
    },
    [persistViews, views],
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
      <span>Aéza · Контур удержания</span>
      <span>Источник: евроценты · Панель: евро</span>
    </footer>
  );

  const topRescue = rescueQueue?.items[0] ?? null;
  const overviewRiskCount =
    !summary || !overviewRisk
      ? 0
      : overviewRisk === "high"
        ? summary.highRisk
        : overviewRisk === "medium"
          ? summary.mediumRisk
          : overviewRisk === "low"
            ? summary.lowRisk
            : summary.unratedCount;
  const overviewRiskShare =
    summary && summary.customerCount > 0
      ? Math.round((overviewRiskCount / summary.customerCount) * 100)
      : 0;

  const overviewPage = (
    <>
      <section className="page-heading overview-heading">
        <div className="page-heading-copy">
          <span className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            Центр удержания
          </span>
          <h1 ref={setHeadingRef} tabIndex={-1}>
            Риск оттока<span className="heading-period">.</span>
          </h1>
          <p>
            Aéza Контур превращает снимок аккаунтов в очередь действий: кто уходит,
            почему именно сейчас и сколько выручки это стоит — с объяснением каждого
            балла и what-if моделью.
          </p>
          <div className="hero-actions">
            <md-filled-button trailingIcon onClick={showHighRisk}>
              Открыть Risk Inbox{summary ? ` · ${integer(summary.highRisk)}` : ""}
              <span slot="icon" className="md-icon-wrap">
                <IconArrowRight />
              </span>
            </md-filled-button>
            <md-filled-tonal-button onClick={() => goToPage("model")}>
              What-if: покрутить веса
            </md-filled-tonal-button>
          </div>
        </div>
        <div className="heading-side">
          <div className="heading-meta">
            <span className="date-label">{todayLabel()}</span>
            <a href="/api/v1/docs" target="_blank" rel="noreferrer" className="docs-link">
              API и документация <IconArrowUpRight />
            </a>
          </div>
          <MascotStage
            eyebrow="Aéza-тян · первый шаг"
            title={
              topRescue
                ? `Сначала: ${topRescue.email}`
                : summary
                  ? summary.highRisk > 0
                    ? `${integer(summary.highRisk)} ${customerWord(summary.highRisk)} ждут контакта`
                    : "Срочных рисков сейчас нет"
                  : "Собираю свежий снимок"
            }
            text={
              topRescue
                ? `${topRescue.actionLabel}: ${topRescue.actionDetail} На кону ${moneyFormat(topRescue.rescueValue)}.`
                : summary
                  ? summary.highRisk > 0
                    ? "Начну с высокого риска: там самая дорогая выручка и понятные причины."
                    : "Можно спокойно проверить средний сегмент и плановые продления."
                  : "Проверяю клиентов, услуги и сигналы модели."
            }
            actionLabel={topRescue ? "Открыть этого клиента" : summary && summary.highRisk > 0 ? "Открыть очередь" : undefined}
            onAction={
              topRescue
                ? () => openCustomer(topRescue.customerId, topRescue.riskLevel)
                : summary && summary.highRisk > 0
                  ? showHighRisk
                  : undefined
            }
          />
        </div>
      </section>

      {summary ? (
        <KpiCards summary={summary} onShowHighRisk={showHighRisk} />
      ) : (
        <KpiSkeletons />
      )}

      <section className="overview-workgrid" aria-label="Действия и распределение скора">
        <Suspense fallback={<PanelSkeleton />}>
          <RescueQueue data={rescueQueue} onOpenCustomer={openCustomer} />
        </Suspense>
        <Suspense fallback={<PanelSkeleton />}>
          <RiskBars
            customers={landscapeCustomers}
            onOpen={(customer) => openCustomer(customer.id, customer.riskLevel)}
          />
        </Suspense>
      </section>

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
            <RiskDonut summary={summary} activeRisk={overviewRisk} onSelectRisk={handleOverviewRiskSelect} />
          ) : (
            <div className="donut-skeleton skeleton" aria-hidden="true" />
          )}
          <p className="panel-hint">
            Зажмите и ведите по сегменту или легенде — выбор поменяется прямо здесь, без перехода.
          </p>
          {overviewRisk && (
            <button type="button" className="donut-open-segment" onClick={openOverviewRiskSegment}>
              Открыть «{RISK_LABELS[overviewRisk]}» в Клиентах
              <IconArrowRight />
            </button>
          )}
        </motion.article>

        {summary ? (
          <Suspense fallback={<PanelSkeleton />}>
            <RiskStream
              summary={summary}
              customers={landscapeCustomers}
              onOpenCustomer={(customerId, riskLevel) => openCustomer(customerId, riskLevel)}
            />
          </Suspense>
        ) : (
          <motion.article
            className="panel riskstream-panel"
            variants={fadeRise}
            custom={0.16}
            initial="hidden"
            animate="show"
            aria-hidden="true"
          >
            <div className="donut-skeleton skeleton" />
          </motion.article>
        )}
      </section>

      {summary && (
        <section className="overview-support-grid" aria-label="Сегмент, сценарии и качество данных">
          <section className="overview-insights" aria-label="Сценарии, динамика и качество данных">
            <RevenueCalculator lossHigh={levelLosses.high} lossMedium={levelLosses.medium} />
            <ScoreHistory points={historyPoints} />
            <DataQuality
              summary={summary}
              customers={landscapeCustomers}
              onShowUnrated={showUnrated}
            />
          </section>
          <motion.article
            className="panel overview-segment-summary"
            variants={fadeRise}
            custom={0.18}
            initial="hidden"
            animate="show"
            aria-label="Выбранный сегмент риска"
          >
            <div className="panel-heading">
              <div>
                <span className="eyebrow">На этом экране</span>
                <h2>{overviewRisk ? RISK_LABELS[overviewRisk] : "Весь портфель"}</h2>
              </div>
              <span className="panel-meta">выбор доната</span>
            </div>
            <strong className="overview-segment-value">
              {integer(overviewRisk ? overviewRiskCount : summary.customerCount)}
            </strong>
            <span className="overview-segment-caption">
              {overviewRisk
                ? `${integer(overviewRiskShare)}% всех клиентов в выбранном сегменте`
                : "клиентов в текущем снимке"}
            </span>
            <dl className="overview-segment-list">
              <div><dt>Высокий</dt><dd>{integer(summary.highRisk)}</dd></div>
              <div><dt>Средний</dt><dd>{integer(summary.mediumRisk)}</dd></div>
              <div><dt>Низкий</dt><dd>{integer(summary.lowRisk)}</dd></div>
              <div><dt>Нет оценки</dt><dd>{integer(summary.unratedCount)}</dd></div>
            </dl>
            {overviewRisk ? (
              <button type="button" className="donut-open-segment" onClick={openOverviewRiskSegment}>
                Открыть сегмент в Клиентах <IconArrowRight />
              </button>
            ) : (
              <p className="panel-hint">Выберите сегмент на донате — страница не поменяется.</p>
            )}
          </motion.article>
        </section>
      )}
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

      <MascotTip
        storageKey="customers-selection-v1"
        title={customers.items[0] ? "Начнём с первой строки" : "В этой выборке пока пусто"}
        actionLabel={customers.items[0] ? "Развернуть первую строку" : undefined}
        onAction={customers.items[0] ? () => setExpandedId(customers.items[0].id) : undefined}
      >
        {customers.items[0] ? (
          <p>
            В выборке {integer(customers.total)} {customerWord(customers.total)}. Первая строка — {customers.items[0].email}
            {customers.items[0].score != null ? `, скор ${integer(customers.items[0].score)}` : ""}; внутри карточки видны причины,
            услуги и расчёт денег.
          </p>
        ) : (
          <p>Смягчите фильтр риска или загрузите снимок — как только появятся клиенты, я покажу, с кого начать.</p>
        )}
      </MascotTip>

      <motion.section
        className="panel table-panel"
        variants={fadeRise}
        custom={0.06}
        initial="hidden"
        animate="show"
        aria-label="Список клиентов"
      >
        <CustomerList
          weights={settings?.weights}
          featureLabels={settings?.features}
          views={views}
          activeViewId={activeViewId}
          onApplyView={handleApplyView}
          onSaveView={handleSaveView}
          onDeleteView={handleDeleteView}
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
          <p>Веса сигналов объяснимой эвристики. Сначала посмотрите what-if эффект без сохранения — затем примените, и сервер пересчитает всех клиентов.</p>
        </div>
        <div className="heading-side">
          <span className="date-label">{todayLabel()}</span>
          <span className={`saved-status saved-${weightsDirty && saveStatus === "synced" ? "dirty" : saveStatus}`} role="status" aria-live="polite">
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
                ? "Применяем…"
                : saveStatus === "error"
                  ? "Не применено"
                  : weightsDirty
                    ? "Сценарий не применён"
                    : "Синхронизировано"}
            </span>
          </span>
        </div>
      </section>

      {summary ? <ModelImpact summary={summary} /> : <KpiSkeletons />}

      <MascotTip
        storageKey="model-weights-v1"
        title={weightsDirty ? "Сначала посмотрите, кто переедет" : "Я берегу сохранённую модель"}
        actionLabel={weightsDirty ? "Сбросить сценарий" : undefined}
        onAction={weightsDirty ? resetDraft : undefined}
      >
        {weightsDirty && simulation ? (
          <p>
            В локальном сценарии уровень меняют {integer(simulation.movers.length)} из {integer(landscapeCustomers.length)}
            загруженных клиентов. Ничего не применится, пока вы явно не нажмёте сохранение в карточке сценария.
          </p>
        ) : (
          <p>Двигайте по одному весу: так проще понять, какой сигнал реально меняет очередь, а какой только шумит.</p>
        )}
      </MascotTip>

      <div className={`model-grid${settings && simulation ? "" : " model-grid-solo"}`}>
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
              Ползунки меняют только локальный сценарий. Карточка сценария справа мгновенно
              показывает, кто сменит уровень и как изменится выручка под риском, — до
              любого сохранения.
            </p>
          </div>
        </div>
        {settings ? (
          <WeightControls settings={weightDraft ? { ...settings, weights: weightDraft } : settings} onWeightChange={handleWeightChange} />
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

      {settings && simulation && (
        <WhatIfPanel
          sim={simulation}
          currentCounts={landscapeCounts}
          currentLoss={landscapeLoss}
          customersLoaded={landscapeCustomers.length}
          dirty={weightsDirty}
          saving={saveStatus === "saving"}
          onSave={() => void applyWeights()}
          onReset={resetDraft}
          onOpenCustomer={openCustomer}
        />
      )}
      </div>
      {pageFooter}
    </>
  );

  const livePage = (
    <>
      <section className="page-heading page-heading-compact">
        <div className="page-heading-copy">
          <span className="eyebrow">
            <span className="eyebrow-line" aria-hidden="true" />
            Realtime Operations
          </span>
          <h1 ref={setHeadingRef} tabIndex={-1}>
            Live-монитор<span className="heading-period">.</span>
          </h1>
          <p>
            Разработческая панель событий: DEMO-поток проходит настоящий backend-расчёт,
            сохраняется в историю, уведомляет Aéza-тян и запускает шаблоны реакций.
          </p>
        </div>
        <div className="heading-side">
          <span className="date-label">{todayLabel()}</span>
          <span className="panel-meta">DEMO не изменяет live-снимок</span>
        </div>
      </section>

      <Suspense fallback={<PanelSkeleton />}>
        <DevPanel
          customers={landscapeCustomers}
          onOpenCustomer={openAlertCustomer}
          onPortfolioChange={refreshFromRealtime}
        />
      </Suspense>
      {pageFooter}
    </>
  );

  /* ---------------- render ---------------- */

  return (
    <div className="app-shell" data-sidebar={sidebarMode}>
      <a className="skip-link" href="#mainContent">
        Перейти к содержимому
      </a>
      <Sidebar
        collapsed={sidebarMode === "rail"}
        onToggleSidebar={toggleSidebar}
        activeSection={page}
        onNavigate={goToPage}
        customerCount={summary ? integer(summary.customerCount) : "—"}
        username={username}
        onLogout={() => void logout()}
      />

      <main
        className="main-content"
        id="mainContent"
        tabIndex={-1}
      >
        <Topbar
          sectionLabel={
            {
              overview: "Обзор",
              customers: "Клиенты",
              model: "Модель риска",
              live: "Live-монитор",
            }[page]
          }
          theme={theme}
          onToggleTheme={toggleTheme}
          connectionError={connectionError}
          lastUpdatedAt={lastUpdatedAt}
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
            {page === "overview"
              ? overviewPage
              : page === "customers"
                ? customersPage
                : page === "model"
                  ? modelPage
                  : livePage}
          </motion.div>
        </AnimatePresence>
      </main>

      <MobileNav activeSection={page} onNavigate={goToPage} />
      <Suspense fallback={null}>
        <RealtimeAlerts
          onOpenCustomer={openAlertCustomer}
          onPortfolioChange={refreshFromRealtime}
        />
      </Suspense>
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
