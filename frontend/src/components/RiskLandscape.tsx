import { useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useMotionTemplate,
  useMotionValue,
  useSpring,
  useTransform,
} from "framer-motion";
import type { Customer } from "../types";
import { RISK_LABELS } from "../types";
import { integer, money } from "../format";
import { fadeRise, springSnappy } from "../motion";
import { AnimatedNumber } from "./AnimatedNumber";

interface RiskLandscapeProps {
  customers: Customer[];
  onOpen: (customer: Customer) => void;
}

const MAX_BARS = 30;
const PAD = 16;

/**
 * "3D map" of revenue at risk — an honest use of the data the API actually
 * has (snapshots carry no geography): every customer is a column on a
 * tiltable CSS-3D plane, height = 90-day revenue at risk (sqrt scale so
 * mid-size bars stay readable), colour = risk level. Columns grow in with
 * a stagger; hovering/clicking selects one and the inspector on the side
 * explains it. Drag rotates the plane.
 */
export function RiskLandscape({ customers, onOpen }: RiskLandscapeProps) {
  const bars = useMemo(() => {
    const rated = customers.filter((customer) => customer.score != null);
    return [...rated]
      .sort((a, b) => b.estimatedLoss - a.estimatedLoss || (b.score ?? 0) - (a.score ?? 0))
      .slice(0, MAX_BARS);
  }, [customers]);

  const maxLoss = Math.max(0, ...bars.map((bar) => bar.estimatedLoss));

  /* Adaptive grid: few customers get big chunky columns, not lost chips. */
  const cols = bars.length <= 4 ? 2 : bars.length <= 8 ? 4 : bars.length <= 15 ? 5 : 6;
  const cell = cols <= 2 ? 58 : cols === 4 ? 50 : cols === 5 ? 42 : 36;
  const gap = cols <= 4 ? 18 : 14;
  const rows = Math.max(1, Math.ceil(bars.length / cols));
  const ghosts = rows * cols - bars.length;
  const planeWidth = PAD * 2 + cols * cell + (cols - 1) * gap;
  const planeHeight = PAD * 2 + rows * cell + (rows - 1) * gap;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = bars.find((bar) => bar.id === selectedId) ?? bars[0] ?? null;
  const selectedRank = selected ? bars.indexOf(selected) + 1 : 0;

  /* Entrance: plane sweeps in, columns grow with a stagger. */
  const offset = useMotionValue(-16);
  const smoothOffset = useSpring(offset, { stiffness: 90, damping: 20, mass: 0.9 });
  const azimuth = useTransform(smoothOffset, (value) => -38 + value);
  const planeTransform = useMotionTemplate`translate(-50%, -58%) rotateX(55deg) rotateZ(${azimuth}deg)`;

  const [grown, setGrown] = useState(false);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    offset.set(0);
    const growTimer = window.setTimeout(() => setGrown(true), 80);
    const settleTimer = window.setTimeout(() => setSettled(true), 1600);
    return () => {
      window.clearTimeout(growTimer);
      window.clearTimeout(settleTimer);
    };
  }, [offset]);

  const dragStart = useRef<{ x: number; offset: number } | null>(null);
  const suppressClick = useRef(false);

  const heightFor = (customer: Customer): number => {
    if (maxLoss > 0) return 20 + Math.sqrt(customer.estimatedLoss / maxLoss) * 150;
    return 20 + ((customer.score ?? 0) / 100) * 140;
  };

  const expiryText = (customer: Customer): string =>
    customer.daysToExpiry == null
      ? "—"
      : customer.daysToExpiry < 0
        ? "срок прошёл"
        : `через ${integer(Math.round(customer.daysToExpiry))} дн.`;

  return (
    <motion.section
      className="panel landscape-panel"
      variants={fadeRise}
      custom={0.14}
      initial="hidden"
      animate="show"
      aria-label="3D-карта выручки под риском"
    >
      <div className="panel-heading">
        <div className="section-heading-copy">
          <span className="eyebrow">Ландшафт риска · 3D</span>
          <h2>Карта выручки под риском</h2>
          <p>
            Каждый столбец — клиент: высота — деньги под угрозой на 90 дней, цвет — уровень
            риска. Наведите или кликните столбец — детали появятся справа; двойной клик
            сразу открывает клиента. Плоскость вращается перетаскиванием.
          </p>
        </div>
        <span className="panel-meta">Топ-{bars.length} по выручке под риском</span>
      </div>

      {bars.length === 0 ? (
        <div className="table-state">
          <strong>Пока нечего нанести на карту</strong>
          <span>Оценённые клиенты появятся здесь после загрузки снимка с услугами.</span>
        </div>
      ) : (
        <div className="landscape-body">
          <div
            className="landscape-scene"
            role="group"
            aria-label={`3D-карта: ${bars.length} клиентов столбцами по выручке под риском. Самый высокий столбец — ${money(maxLoss)}. Перетаскивание вращает плоскость.`}
            onPointerDown={(event) => {
              dragStart.current = { x: event.clientX, offset: offset.get() };
              suppressClick.current = false;
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                /* capture is progressive enhancement */
              }
            }}
            onPointerMove={(event) => {
              if (!dragStart.current) return;
              const dx = event.clientX - dragStart.current.x;
              if (Math.abs(dx) > 6) suppressClick.current = true;
              offset.set(Math.max(-32, Math.min(32, dragStart.current.offset + dx * 0.25)));
            }}
            onPointerUp={() => {
              dragStart.current = null;
            }}
            onPointerCancel={() => {
              dragStart.current = null;
            }}
          >
            <motion.div
              className="landscape-plane"
              style={{ width: planeWidth, height: planeHeight, transform: planeTransform }}
            >
              {bars.map((customer, index) => {
                const col = index % cols;
                const row = Math.floor(index / cols);
                const height = Math.round(heightFor(customer));
                const isSelected = selected?.id === customer.id;
                return (
                  <div
                    key={customer.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected}
                    className={`landscape-cell land-${customer.riskLevel}${isSelected ? " is-selected" : ""}`}
                    style={
                      {
                        left: PAD + col * (cell + gap),
                        top: PAD + row * (cell + gap),
                        "--cell": `${cell}px`,
                        "--h": `${grown ? height : 6}px`,
                        "--d": settled ? "0ms" : `${index * 45}ms`,
                      } as React.CSSProperties
                    }
                    title={`${customer.email} · ${RISK_LABELS[customer.riskLevel]} риск ${customer.score ?? "—"} · под риском ${money(customer.estimatedLoss)}`}
                    aria-label={`Выбрать на карте клиента ${customer.email}: риск ${customer.score ?? "—"}, под риском ${money(customer.estimatedLoss)}`}
                    onPointerEnter={(event) => {
                      if (event.pointerType === "mouse") setSelectedId(customer.id);
                    }}
                    onClick={() => {
                      if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                      }
                      setSelectedId(customer.id);
                    }}
                    onDoubleClick={() => onOpen(customer)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedId(customer.id);
                      }
                    }}
                  >
                    <span className="land-face land-front" aria-hidden="true" />
                    <span className="land-face land-east" aria-hidden="true" />
                    <span className="land-face land-top" aria-hidden="true" />
                  </div>
                );
              })}
              {Array.from({ length: ghosts }, (_, index) => {
                const slot = bars.length + index;
                const col = slot % cols;
                const row = Math.floor(slot / cols);
                return (
                  <span
                    key={`ghost-${index}`}
                    className="land-ghost"
                    aria-hidden="true"
                    style={{
                      left: PAD + col * (cell + gap),
                      top: PAD + row * (cell + gap),
                      width: cell,
                      height: cell,
                    }}
                  />
                );
              })}
            </motion.div>
            <div className="landscape-vignette" aria-hidden="true" />
            <span className="landscape-scale" aria-hidden="true">
              высота = выручка под риском · макс. {money(maxLoss)}
            </span>
          </div>

          <aside className="landscape-inspector" aria-live="polite">
            <AnimatePresence mode="wait" initial={false}>
              {selected ? (
                <motion.div
                  key={selected.id}
                  className="land-insp-body"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={springSnappy}
                >
                  <div className="land-insp-head">
                    <span className={`land-insp-pill land-insp-${selected.riskLevel}`}>
                      <span className={`risk-dot risk-dot-${selected.riskLevel}`} aria-hidden="true" />
                      {RISK_LABELS[selected.riskLevel]} риск
                    </span>
                    <span className="land-insp-rank">№{selectedRank} по деньгам под риском</span>
                  </div>
                  <strong className="land-insp-email" title={selected.email}>
                    {selected.email}
                  </strong>
                  <div className="land-insp-score">
                    <AnimatedNumber value={selected.score ?? 0} format={integer} />
                    <span>риск-скор из 100</span>
                  </div>
                  <div className="land-insp-stats">
                    <div>
                      <span>Под риском · 90 дней</span>
                      <strong>{money(selected.estimatedLoss)}</strong>
                    </div>
                    <div>
                      <span>Выручка в месяц</span>
                      <strong>{money(selected.monthlyRevenue)}</strong>
                    </div>
                    <div>
                      <span>Ближайшее окончание</span>
                      <strong>{expiryText(selected)}</strong>
                    </div>
                    <div>
                      <span>Баланс</span>
                      <strong>{money(selected.balance)}</strong>
                    </div>
                  </div>
                  {selected.reasons?.[0] && (
                    <p className="land-insp-reason">{selected.reasons[0]}</p>
                  )}
                  <motion.button
                    type="button"
                    className="button button-primary land-insp-open"
                    onClick={() => onOpen(selected)}
                    whileTap={{ scale: 0.96 }}
                    transition={springSnappy}
                  >
                    Открыть в очереди
                  </motion.button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </aside>
        </div>
      )}

      <div className="landscape-legend" aria-hidden="true">
        <span><span className="risk-dot risk-dot-high" /> Высокий</span>
        <span><span className="risk-dot risk-dot-medium" /> Средний</span>
        <span><span className="risk-dot risk-dot-low" /> Низкий</span>
        <span className="landscape-hint">Вращение — перетаскиванием по карте · двойной клик открывает клиента</span>
      </div>
    </motion.section>
  );
}
