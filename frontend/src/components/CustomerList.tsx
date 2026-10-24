import { forwardRef, memo, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Customer, RiskLevel, SortKey, SortOrder } from "../types";
import {
  PAYMENT_LABELS,
  RISK_LABELS,
  SERVICE_STATUS_LABELS,
} from "../types";
import { api, ApiError } from "../api";
import { dateLabel, integer, money } from "../format";
import {
  emphasizedTween,
  rowPageVariants,
  springEmphasized,
  springFollow,
  springSnappy,
  staggerChild,
  staggerParent,
} from "../motion";
import { AnimatedNumber } from "./AnimatedNumber";
import { useDragSelect } from "./useDragSelect";
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowUpRight,
  IconCheck,
  IconChevron,
  IconCopy,
  IconMail,
} from "../icons";

/* ------------------------------------------------------------------ */
/*  Segmented risk filter — M3 segmented buttons with a sliding thumb */
/* ------------------------------------------------------------------ */

export interface RiskOption {
  value: RiskLevel | "";
  label: string;
}

export const RISK_OPTIONS: RiskOption[] = [
  { value: "", label: "Все" },
  { value: "high", label: "Высокий" },
  { value: "medium", label: "Средний" },
  { value: "low", label: "Низкий" },
  { value: "unrated", label: "Нет оценки" },
];
const RISK_VALUES = RISK_OPTIONS.map((option) => option.value);

function SegmentedFilter({
  value,
  onChange,
}: {
  value: RiskLevel | "";
  onChange: (value: RiskLevel | "") => void;
}) {
  const drag = useDragSelect<RiskLevel | "">({
    values: RISK_VALUES,
    selected: value,
    axis: "x",
    allowTouch: true,
    onCommit: (next) => onChange(next),
  });

  return (
    <div
      className="segmented drag-select drag-select-touch-x"
      role="group"
      aria-label="Фильтр по уровню риска. Можно зажать и вести указатель."
      ref={drag.containerRef}
      data-dragging={drag.dragging || undefined}
      {...drag.containerHandlers}
    >
      {drag.thumbRect && (
        <motion.span
          className="segmented-thumb drag-thumb"
          aria-hidden="true"
          initial={false}
          animate={{
            x: drag.thumbRect.x,
            y: drag.thumbRect.y,
            width: drag.thumbRect.w,
            height: drag.thumbRect.h,
            opacity: 1,
          }}
          transition={springFollow}
        />
      )}
      {RISK_OPTIONS.map((option) => {
        const selected = drag.active === option.value;
        return (
          <button
            key={option.label}
            ref={drag.registerItem(option.value)}
            type="button"
            className={`segmented-item${selected ? " is-selected" : ""}`}
            aria-pressed={value === option.value}
            onClick={(event) => drag.handleItemClick(option.value, event)}
          >
            <span className="segmented-label">
              {option.value && (
                <span className={`risk-dot risk-dot-${option.value}`} aria-hidden="true" />
              )}
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Score ring — animated arc for the expanded customer                */
/* ------------------------------------------------------------------ */

function ScoreRing({ customer }: { customer: Customer }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const score = customer.score ?? 0;
  const filled = (score / 100) * circumference;
  return (
    <div
      className={`score-ring score-ring-${customer.riskLevel}`}
      role="img"
      aria-label={
        customer.score == null
          ? "Оценка риска недоступна"
          : `Оценка риска ${score} из 100, уровень — ${RISK_LABELS[customer.riskLevel].toLowerCase()}`
      }
    >
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle className="score-ring-track" cx="50" cy="50" r={radius} />
        <motion.circle
          className="score-ring-fill"
          cx="50"
          cy="50"
          r={radius}
          initial={{ strokeDasharray: `0 ${circumference}` }}
          animate={{ strokeDasharray: `${filled} ${circumference - filled}` }}
          transition={{ ...emphasizedTween, duration: 0.8, delay: 0.1 }}
        />
      </svg>
      <div className="score-ring-center" aria-hidden="true">
        {customer.score == null ? (
          <strong>—</strong>
        ) : (
          <AnimatedNumber value={score} format={integer} />
        )}
        <span>{customer.score == null ? "нет оценки" : "из 100"}</span>
      </div>
    </div>
  );
}

/** Presentation-only next step, derived from the signals the API already returns. */
function nextStep(customer: Customer): string {
  const features = customer.features || {};
  if (features.prolong_wait)
    return "Связаться сегодня — услуга уже ожидает оплаты в льготном периоде.";
  if (features.insufficient_funds)
    return "Предупредить о недостатке средств и предложить пополнить баланс до даты продления.";
  if (features.failed_transactions)
    return "Проверить способ оплаты — в снимке есть незавершённые платежи.";
  if (features.expiring_without_autoprolong)
    return "Напомнить о скором окончании услуги и предложить включить автопродление.";
  if (customer.riskLevel === "high")
    return "Поставить клиента первым в очередь контакта команды удержания.";
  if (customer.riskLevel === "medium")
    return "Плановый контакт на этой неделе, до усиления сигналов.";
  if (customer.riskLevel === "unrated")
    return "Данных пока мало — вернуться после появления услуг или транзакций.";
  return "Срочных действий не требуется — клиент остаётся под наблюдением.";
}

/* ------------------------------------------------------------------ */
/*  Expanded detail                                                    */
/* ------------------------------------------------------------------ */

/**
 * Fallback labels mirroring FEATURE_LABELS in churnrisk/domain.py. The API
 * also returns them as settings.features, which takes precedence.
 */
const FACTOR_LABELS: Record<string, string> = {
  expiring_without_autoprolong: "Скорое окончание без автопродления",
  insufficient_funds: "Не хватает средств на продление",
  prolong_wait: "Услуга ожидает оплаты",
  failed_transactions: "Незавершённые платежи",
  deleted_services: "Удалённые услуги",
  balance_pressure: "Высокая нагрузка на баланс",
};

/**
 * "Explain the score": the server score is a weight-normalised sum, and the
 * API returns both the triggered factors (features) and the weights, so the
 * per-factor points below are computed, not invented. Small differences
 * vs. the stored score come from rounding each contribution.
 */
function FactorBreakdown({
  customer,
  weights,
  featureLabels,
}: {
  customer: Customer;
  weights?: Record<string, number>;
  featureLabels?: Record<string, string>;
}) {
  if (customer.score == null) {
    return (
      <motion.section className="detail-section factor-breakdown" variants={staggerChild}>
        <h3>Как сложился риск-скор</h3>
        <p className="empty-detail">
          Score не рассчитан — недостаточно данных об услугах. Это честный пробел данных, а
          не «нулевой риск»; общий масштаб таких клиентов виден в центре качества данных на
          обзоре.
        </p>
      </motion.section>
    );
  }
  const keys = Object.keys(weights ?? {});
  if (!keys.length) return null;
  const totalWeight = keys.reduce(
    (sum, key) => sum + Math.max(Number(weights?.[key]) || 0, 0),
    0,
  );
  const rows = keys
    .map((key) => {
      const weight = Math.max(Number(weights?.[key]) || 0, 0);
      const potential = totalWeight ? Math.round((weight / totalWeight) * 100) : 0;
      const active = Boolean(customer.features?.[key]);
      return {
        key,
        label: featureLabels?.[key] ?? FACTOR_LABELS[key] ?? key,
        active,
        points: active ? potential : 0,
        potential,
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || b.potential - a.potential);
  const earned = rows.reduce((sum, row) => sum + row.points, 0);
  const level = customer.riskLevel || "unrated";

  return (
    <motion.section
      className={`detail-section factor-breakdown factor-${level}`}
      variants={staggerChild}
    >
      <h3>Как сложился риск-скор {integer(customer.score)}</h3>
      <ul className="factor-list">
        {rows.map((row) => (
          <li key={row.key} className={`factor-row${row.active ? " is-active" : ""}`}>
            <span className="factor-label">{row.label}</span>
            <span className="factor-bar" aria-hidden="true">
              <motion.span
                initial={{ width: 0 }}
                animate={{ width: `${row.active ? row.points : row.potential}%` }}
                transition={emphasizedTween}
              />
            </span>
            <span className="factor-points">
              {row.active ? `+${integer(row.points)}` : `0 из +${integer(row.potential)}`}
            </span>
          </li>
        ))}
      </ul>
      <p className="factor-summary">
        Сработавшие факторы дают ≈{integer(earned)} из 100 — это и есть score клиента
        (расхождение в пределах округления вкладов). Веса и пороги настраиваются на
        странице модели; what-if там покажет эффект до сохранения.
      </p>
    </motion.section>
  );
}

function CustomerDetail({
  initial,
  onToast,
  weights,
  featureLabels,
}: {
  initial: Customer;
  onToast: (message: string, persistent?: boolean) => void;
  weights?: Record<string, number>;
  featureLabels?: Record<string, string>;
}) {
  const [customer, setCustomer] = useState<Customer>(initial);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setCustomer(initial);
    api<Customer>(`/api/v1/customers/${encodeURIComponent(initial.id)}`)
      .then((fresh) => {
        if (!cancelled) setCustomer(fresh);
      })
      .catch((error: unknown) => {
        if (!cancelled && error instanceof ApiError && error.status !== 401) {
          onToast(`Не удалось обновить карточку: ${error.message}`, true);
        }
      });
    return () => {
      cancelled = true;
    };
    // Refetch only when a different customer is expanded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.id]);

  const stats: [string, string][] = [
    ["Потенциальные потери за 90 дней", money(customer.estimatedLoss)],
    ["Баланс", money(customer.balance)],
    ["Доступно для продления", money(customer.availableBalance ?? customer.balance)],
    ["Пополнено за всё время", money(customer.totalReplenished)],
    ["Выручка в месяц", money(customer.monthlyRevenue)],
    [
      "Ближайшее окончание",
      customer.daysToExpiry == null
        ? "—"
        : customer.daysToExpiry < 0
          ? "срок прошёл"
          : `через ${integer(Math.round(customer.daysToExpiry))} дн.`,
    ],
  ];

  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(customer.email);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      onToast("Не удалось скопировать email — скопируйте вручную.", true);
    }
  };

  return (
    <motion.div
      className="customer-detail"
      variants={staggerParent}
      initial="hidden"
      animate="show"
    >
      <motion.div className="detail-hero" variants={staggerChild}>
        <ScoreRing customer={customer} />
        <div className="detail-next">
          <span className="detail-next-eyebrow">Следующий шаг</span>
          <p>{nextStep(customer)}</p>
          <div className="detail-actions">
            <md-filled-tonal-button onClick={copyEmail}>
              <span slot="icon" className="md-icon-wrap">
                {copied ? <IconCheck /> : <IconCopy />}
              </span>
              {copied ? "Скопировано" : "Скопировать email"}
            </md-filled-tonal-button>
            {customer.email.includes("@") && (
              <md-outlined-button href={`mailto:${customer.email}`}>
                <span slot="icon" className="md-icon-wrap">
                  <IconMail />
                </span>
                Написать письмо
              </md-outlined-button>
            )}
          </div>
        </div>
      </motion.div>

      <motion.div className="detail-stats" variants={staggerChild}>
        {stats.map(([label, value]) => (
          <div className="detail-stat" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </motion.div>

      <FactorBreakdown customer={customer} weights={weights} featureLabels={featureLabels} />

      <motion.section className="detail-section" variants={staggerChild}>
        <h3>Что повлияло на оценку</h3>
        {customer.reasons?.length ? (
          <ul className="reason-list">
            {customer.reasons.map((reason, index) => (
              <motion.li
                key={`${index}-${reason}`}
                className="reason-item"
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ ...springEmphasized, delay: 0.12 + index * 0.06 }}
              >
                {reason}
              </motion.li>
            ))}
          </ul>
        ) : (
          <p className="empty-detail">Срабатываний нет или данных недостаточно.</p>
        )}
      </motion.section>

      <motion.section className="detail-section" variants={staggerChild}>
        <h3>Услуги клиента</h3>
        {customer.services?.length ? (
          <ul className="service-list">
            {customer.services.map((service, index) => {
              const status =
                SERVICE_STATUS_LABELS[service.status ?? ""] || service.status || "—";
              const term = PAYMENT_LABELS[service.paymentTerm ?? ""] || service.paymentTerm || "—";
              const expiry = service.expiresAt ? dateLabel(service.expiresAt) : "";
              return (
                <motion.li
                  key={`${service.id ?? index}`}
                  className="service-row"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...springEmphasized, delay: 0.16 + index * 0.05 }}
                >
                  <span className="service-main">
                    <strong>{service.name || "Услуга"}</strong>
                    <span>
                      {term}
                      {expiry ? ` · до ${expiry}` : ""}
                      {service.autoprolong != null
                        ? service.autoprolong
                          ? " · автопродление включено"
                          : " · без автопродления"
                        : ""}
                    </span>
                  </span>
                  <span className="service-side">
                    <strong>{money(service.price)}</strong>
                    <span
                      className={`service-status service-status-${service.status ?? "unknown"}`}
                    >
                      {status}
                    </span>
                  </span>
                </motion.li>
              );
            })}
          </ul>
        ) : (
          <p className="empty-detail">Услуги не загружены.</p>
        )}
        <p className="detail-note">
          {customer.features?.failed_transactions
            ? "В снимке есть сигнал о незавершённых платежах. Список отдельных транзакций API не предоставляет."
            : "Отдельные транзакции не входят в данные карточки; показаны доступные суммы пополнений и услуг."}{" "}
          Потери — оценка выручки активных услуг за три месяца после вычета доступного
          баланса, умноженная на долю риска. Это сценарная оценка для приоритизации контакта.
        </p>
      </motion.section>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  One row — itself a morphing card                                   */
/* ------------------------------------------------------------------ */

interface RowProps {
  customer: Customer;
  expanded: boolean;
  direction: number;
  onToggle: (id: string) => void;
  onToast: (message: string, persistent?: boolean) => void;
  weights?: Record<string, number>;
  featureLabels?: Record<string, string>;
}

const CustomerRow = memo(
  forwardRef<HTMLDivElement, RowProps>(function CustomerRow(
    { customer, expanded, direction, onToggle, onToast, weights, featureLabels }: RowProps,
    ref,
  ) {
  const level = customer.riskLevel || "unrated";
  const reason = customer.reasons?.[0] || "Нет данных";
  const initialLetter = (customer.email?.trim()?.[0] || "?").toUpperCase();
  const detailId = `customer-detail-${customer.id}`;

    return (
      <motion.div
        ref={ref}
        className={`customer-row${expanded ? " is-expanded" : ""}`}
        data-risk={level}
        layout="position"
        variants={rowPageVariants}
      initial="enter"
      animate="center"
      exit="exit"
      custom={direction}
      transition={springEmphasized}
      role="listitem"
    >
      <button
        type="button"
        className="row-main"
        onClick={() => onToggle(customer.id)}
        aria-expanded={expanded}
        aria-controls={detailId}
        aria-label={`${expanded ? "Свернуть" : "Открыть"} карточку клиента ${customer.email}`}
      >
        <span className="cell cell-id">#{customer.id}</span>
        <span className="cell cell-client">
          <span className={`client-avatar client-avatar-${level}`} aria-hidden="true">
            {initialLetter}
          </span>
          <span className="client-copy">
            <span className="client-email" title={customer.email}>
              {customer.email}
            </span>
            <span className="client-sub">
              {customer.score == null
                ? "Недостаточно данных для оценки"
                : `Риск ${RISK_LABELS[level].toLowerCase()}`}
            </span>
          </span>
        </span>
        <span className="cell cell-money" data-label="Баланс">
          {money(customer.balance)}
        </span>
        <span className="cell cell-money cell-replenished" data-label="Пополнено">
          {money(customer.totalReplenished)}
        </span>
        <span className="cell cell-reason" title={customer.reasons?.join(" ") || undefined}>
          {reason}
        </span>
        <span className="cell cell-score">
          <motion.span
            layout
            className={`risk-pill risk-pill-${level}`}
            transition={springSnappy}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={`${level}-${customer.score ?? "none"}`}
                initial={{ opacity: 0, scale: 0.8, y: 4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.8, y: -4 }}
                transition={springSnappy}
              >
                {customer.score == null
                  ? "Нет оценки"
                  : `${RISK_LABELS[level]} · ${customer.score}`}
              </motion.span>
            </AnimatePresence>
          </motion.span>
          {customer.score != null && (
            <span className="score-track" aria-hidden="true">
              <motion.span
                className={`score-track-fill score-track-fill-${level}`}
                initial={false}
                animate={{ scaleX: Math.max(0, Math.min(customer.score, 100)) / 100 }}
                transition={springEmphasized}
              />
            </span>
          )}
        </span>
        <motion.span
          className="row-chevron"
          aria-hidden="true"
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={springSnappy}
        >
          <IconChevron />
        </motion.span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id={detailId}
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ ...emphasizedTween, duration: 0.45 }}
            className="row-detail-clip"
          >
            <CustomerDetail initial={customer} onToast={onToast} weights={weights} featureLabels={featureLabels} />
          </motion.div>
        )}
      </AnimatePresence>
      </motion.div>
    );
  }),
);

export interface SavedView {
  id: string;
  name: string;
  risk: RiskLevel | "";
  sort: SortKey;
  order: SortOrder;
}

function ViewChip({
  view,
  active,
  onApply,
  onDelete,
}: {
  view: SavedView;
  active: boolean;
  onApply: (view: SavedView) => void;
  onDelete: (id: string) => void;
}) {
  const chipRef = useRef<HTMLElement | null>(null);
  const removing = useRef(false);

  useEffect(() => {
    const el = chipRef.current;
    if (!el) return;
    const handler = () => {
      removing.current = true;
      onDelete(view.id);
    };
    el.addEventListener("remove", handler);
    return () => el.removeEventListener("remove", handler);
  }, [onDelete, view.id]);

  return (
    <md-input-chip
      ref={chipRef}
      label={view.name}
      selected={active}
      aria-label={`Применить вид «${view.name}»`}
      onClick={() => {
        if (removing.current) {
          removing.current = false;
          return;
        }
        onApply(view);
      }}
    />
  );
}

function SavedViewsBar({
  views,
  activeViewId,
  onApply,
  onSave,
  onDelete,
}: {
  views: SavedView[];
  activeViewId: string | null;
  onApply: (view: SavedView) => void;
  onSave: (name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [formOpen, setFormOpen] = useState(false);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setName("");
    setFormOpen(false);
  };

  return (
    <div className="saved-views" aria-label="Сохранённые представления очереди">
      <span className="saved-views-label">Мои виды</span>
      <div className="saved-views-chips">
        <AnimatePresence initial={false}>
          {views.map((view) => (
            <motion.span
              key={view.id}
              layout
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={springSnappy}
            >
              <ViewChip
                view={view}
                active={view.id === activeViewId}
                onApply={onApply}
                onDelete={onDelete}
              />
            </motion.span>
          ))}
        </AnimatePresence>
        {!views.length && (
          <span className="saved-views-empty">
            Настройте фильтр и сортировку — и сохраните комбинацию как именованный вид.
          </span>
        )}
      </div>
      <AnimatePresence mode="popLayout" initial={false}>
        {formOpen ? (
          <motion.form
            key="form"
            className="saved-view-form"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            transition={springSnappy}
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Например: Высокий риск · по сроку"
              aria-label="Название вида"
              maxLength={40}
              autoFocus
            />
            <md-filled-button disabled={!name.trim()} onClick={submit}>
              Сохранить
            </md-filled-button>
            <md-text-button onClick={() => setFormOpen(false)}>Отмена</md-text-button>
          </motion.form>
        ) : (
          <motion.span
            key="open"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            transition={springSnappy}
          >
            <md-filled-tonal-button onClick={() => setFormOpen(true)}>
              + Сохранить текущий вид
            </md-filled-tonal-button>
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  The panel                                                          */
/* ------------------------------------------------------------------ */

export interface CustomerListProps {
  weights?: Record<string, number>;
  featureLabels?: Record<string, string>;
  views: SavedView[];
  activeViewId: string | null;
  onApplyView: (view: SavedView) => void;
  onSaveView: (name: string) => void;
  onDeleteView: (id: string) => void;
  items: Customer[];
  total: number;
  sort: SortKey;
  order: SortOrder;
  onSort: (sort: SortKey) => void;
  risk: RiskLevel | "";
  onRiskChange: (risk: RiskLevel | "") => void;
  offset: number;
  pageSize: number;
  direction: number;
  onPrevious: () => void;
  onNext: () => void;
  expandedId: string | null;
  onToggle: (id: string) => void;
  onToast: (message: string, persistent?: boolean) => void;
  initialLoading: boolean;
  loadError: string | null;
  onRetry: () => void;
}

const COLUMNS: { key: SortKey | null; label: string; className: string }[] = [
  { key: "id", label: "ID", className: "col-id" },
  { key: "email", label: "Клиент", className: "col-client" },
  { key: "balance", label: "Баланс", className: "col-balance" },
  { key: "totalReplenished", label: "Пополнено", className: "col-money col-replenished" },
  { key: null, label: "Почему риск", className: "col-reason" },
  { key: "score", label: "Риск-скор", className: "col-score" },
  { key: null, label: "", className: "col-chevron" },
];

export function CustomerList(props: CustomerListProps) {
  const {
    weights,
    featureLabels,
    views,
    activeViewId,
    onApplyView,
    onSaveView,
    onDeleteView,
    items,
    total,
    sort,
    order,
    onSort,
    risk,
    onRiskChange,
    offset,
    direction,
    onPrevious,
    onNext,
    expandedId,
    onToggle,
    onToast,
    initialLoading,
    loadError,
    onRetry,
  } = props;

  const first = total ? offset + 1 : 0;
  const last = Math.min(offset + items.length, total);

  return (
    <>
      <div className="panel-heading table-heading">
        <div className="section-heading-copy">
          <span className="eyebrow">Рабочая очередь</span>
          <h2>Приоритет контакта</h2>
          <p>Это Risk Inbox команды: сверху — те, кому пишем сегодня. Фильтр переключается зажатием и ведением указателя, а удачные комбинации фильтра и сортировки сохраняются именованными видами.</p>
        </div>
        <SegmentedFilter value={risk} onChange={onRiskChange} />
      </div>

      <SavedViewsBar
        views={views}
        activeViewId={activeViewId}
        onApply={onApplyView}
        onSave={onSaveView}
        onDelete={onDeleteView}
      />

      <div className="list-head" aria-hidden="false">
        {COLUMNS.map((column, index) =>
          column.key ? (
            <button
              key={column.label || index}
              type="button"
              className={`sort-button ${column.className}${sort === column.key ? " is-active" : ""}`}
              onClick={() => onSort(column.key as SortKey)}
              aria-label={`Сортировать по полю «${column.label}»${
                sort === column.key
                  ? order === "asc"
                    ? ", сейчас по возрастанию"
                    : ", сейчас по убыванию"
                  : ""
              }`}
            >
              {column.label}
              <motion.span
                className="sort-arrow"
                aria-hidden="true"
                animate={{
                  rotate: sort === column.key && order === "asc" ? 180 : 0,
                  opacity: sort === column.key ? 1 : 0.35,
                }}
                transition={springSnappy}
              >
                ↓
              </motion.span>
            </button>
          ) : (
            <span key={column.label || index} className={`list-head-label ${column.className}`}>
              {column.label}
            </span>
          ),
        )}
      </div>

      {initialLoading ? (
        <div className="row-skeletons" aria-label="Загружаем клиентов">
          {[0, 1, 2, 3, 4].map((index) => (
            <div key={index} className="row-skeleton" aria-hidden="true">
              <span className="skeleton skeleton-avatar" />
              <span className="skeleton skeleton-line skeleton-line-wide" />
              <span className="skeleton skeleton-line" />
              <span className="skeleton skeleton-pill" />
            </div>
          ))}
          <span className="sr-only">Загружаем клиентов…</span>
        </div>
      ) : loadError && items.length === 0 ? (
        <div className="table-state">
          <strong>Не удалось загрузить данные</strong>
          <span>{loadError}</span>
          <md-filled-tonal-button onClick={onRetry}>Повторить</md-filled-tonal-button>
        </div>
      ) : items.length === 0 ? (
        <motion.div
          className="table-state"
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={springEmphasized}
        >
          <strong>Для выбранного фильтра клиентов нет</strong>
          <span>Попробуйте другой уровень риска — список перестроится сам.</span>
        </motion.div>
      ) : (
        <motion.div className="customer-rows" role="list" layoutScroll={false}>
          <AnimatePresence mode="popLayout" custom={direction} initial={false}>
            {items.map((customer) => (
              <CustomerRow
                key={customer.id}
                customer={customer}
                expanded={expandedId === customer.id}
                direction={direction}
                onToggle={onToggle}
                onToast={onToast}
                weights={weights}
                featureLabels={featureLabels}
              />
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      <div className="table-footer">
        <span className="table-count" role="status">
          {integer(total)} {total === 1 ? "клиент" : total % 10 >= 2 && total % 10 <= 4 && (total % 100 < 12 || total % 100 > 14) ? "клиента" : "клиентов"}
          {risk ? ` · фильтр: ${RISK_LABELS[risk].toLowerCase()} риск` : ""}
        </span>
        <div className="table-pagination" aria-label="Навигация по страницам клиентов">
          <md-icon-button
            onClick={onPrevious}
            disabled={offset === 0}
            aria-label="Предыдущая страница"
          >
            <span className="md-icon-wrap">
              <IconArrowLeft />
            </span>
          </md-icon-button>
          <span role="status" aria-live="polite">
            {integer(first)}–{integer(last)} из {integer(total)}
          </span>
          <md-icon-button
            onClick={onNext}
            disabled={offset + items.length >= total}
            aria-label="Следующая страница"
          >
            <span className="md-icon-wrap">
              <IconArrowRight />
            </span>
          </md-icon-button>
        </div>
        <a
          href="/api/v1/docs"
          target="_blank"
          rel="noreferrer"
          className="table-api-link"
        >
          API <IconArrowUpRight />
        </a>
      </div>
    </>
  );
}
