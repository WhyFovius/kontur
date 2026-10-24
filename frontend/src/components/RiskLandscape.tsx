import { useEffect, useMemo, useRef } from "react";
import { motion, useMotionTemplate, useMotionValue, useSpring, useTransform } from "framer-motion";
import type { Customer } from "../types";
import { RISK_LABELS } from "../types";
import { money } from "../format";
import { fadeRise } from "../motion";

interface RiskLandscapeProps {
  customers: Customer[];
  onOpen: (customer: Customer) => void;
}

const COLS = 6;
const PITCH = 46;
const CELL = 34;
const MAX_BARS = 36;

/**
 * "3D map" of revenue at risk — an honest use of the data the API actually
 * has (there are no geography fields in snapshots): every customer is a
 * column on a tiltable CSS-3D plane, height = 90-day revenue at risk,
 * colour = risk level, number on top = score. Drag rotates the plane;
 * clicking a column opens that customer in the work queue.
 */
export function RiskLandscape({ customers, onOpen }: RiskLandscapeProps) {
  const bars = useMemo(() => {
    const rated = customers.filter((customer) => customer.score != null);
    return [...rated]
      .sort((a, b) => (b.estimatedLoss - a.estimatedLoss) || ((b.score ?? 0) - (a.score ?? 0)))
      .slice(0, MAX_BARS);
  }, [customers]);

  const maxLoss = Math.max(0, ...bars.map((bar) => bar.estimatedLoss));
  const rows = Math.max(1, Math.ceil(bars.length / COLS));
  const planeWidth = COLS * PITCH;
  const planeHeight = rows * PITCH;

  const offset = useMotionValue(-18);
  const smoothOffset = useSpring(offset, { stiffness: 90, damping: 20, mass: 0.9 });
  const azimuth = useTransform(smoothOffset, (value) => -38 + value);
  const planeTransform = useMotionTemplate`translate(-50%, -56%) rotateX(56deg) rotateZ(${azimuth}deg)`;

  const dragStart = useRef<{ x: number; offset: number } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    offset.set(0);
  }, [offset]);

  const heightFor = (customer: Customer): number => {
    if (maxLoss > 0) return 14 + (customer.estimatedLoss / maxLoss) * 132;
    return 14 + ((customer.score ?? 0) / 100) * 132;
  };

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
            риска, число сверху — score. Зажмите и тяните, чтобы вращать; клик по столбцу
            открывает клиента.
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
        <div
          className="landscape-scene"
          role="img"
          aria-label={`3D-карта: ${bars.length} клиентов, самый высокий столбец — ${money(maxLoss)} под риском.`}
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
            offset.set(Math.max(-30, Math.min(30, dragStart.current.offset + dx * 0.25)));
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
              const col = index % COLS;
              const row = Math.floor(index / COLS);
              const height = Math.round(heightFor(customer));
              return (
                <div
                  key={customer.id}
                  role="button"
                  tabIndex={0}
                  className={`landscape-cell land-${customer.riskLevel}`}
                  style={
                    {
                      left: col * PITCH + (PITCH - CELL) / 2,
                      top: row * PITCH + (PITCH - CELL) / 2,
                      "--h": `${height}px`,
                    } as React.CSSProperties
                  }
                  title={`${customer.email} · ${RISK_LABELS[customer.riskLevel]} риск ${customer.score ?? "—"} · под риском ${money(customer.estimatedLoss)}`}
                  aria-label={`Открыть клиента ${customer.email}: риск ${customer.score ?? "—"}, под риском ${money(customer.estimatedLoss)}`}
                  onClick={() => {
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    onOpen(customer);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpen(customer);
                    }
                  }}
                >
                  <span className="land-face land-front" aria-hidden="true" />
                  <span className="land-face land-east" aria-hidden="true" />
                  <span className="land-face land-top" aria-hidden="true">
                    {customer.score ?? "—"}
                  </span>
                </div>
              );
            })}
          </motion.div>
          <span className="landscape-scale" aria-hidden="true">
            макс. столбец — {money(maxLoss)}
          </span>
        </div>
      )}

      <div className="landscape-legend" aria-hidden="true">
        <span><span className="risk-dot risk-dot-high" /> Высокий</span>
        <span><span className="risk-dot risk-dot-medium" /> Средний</span>
        <span><span className="risk-dot risk-dot-low" /> Низкий</span>
        <span className="landscape-hint">Вращение — перетаскиванием по карте</span>
      </div>
    </motion.section>
  );
}
