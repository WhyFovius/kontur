import { useMemo } from "react";
import { motion } from "framer-motion";
import type { Customer, RiskLevel, Summary } from "../types";
import { RISK_LABELS } from "../types";
import { customerWord, integer, money } from "../format";
import { fadeRise } from "../motion";

interface GlassFoldersProps {
  summary: Summary;
  customers: Customer[];
  losses: Record<RiskLevel, number>;
  onSelectLevel: (level: RiskLevel) => void;
  onOpen: (customer: Customer) => void;
}

const FOLDERS: { level: RiskLevel; hint: string }[] = [
  { level: "high", hint: "контакт сегодня" },
  { level: "medium", hint: "плановый контакт" },
  { level: "low", hint: "под наблюдением" },
  { level: "unrated", hint: "нужно больше данных" },
];

function countFor(summary: Summary, level: RiskLevel): number {
  switch (level) {
    case "high":
      return summary.highRisk;
    case "medium":
      return summary.mediumRisk;
    case "low":
      return summary.lowRisk;
    default:
      return summary.unratedCount;
  }
}

interface FolderProps {
  level: RiskLevel;
  hint: string;
  count: number;
  loss: number;
  people: Customer[];
  index: number;
  onSelectLevel: (level: RiskLevel) => void;
  onOpen: (customer: Customer) => void;
}

function GlassFolder({
  level,
  hint,
  count,
  loss,
  people,
  index,
  onSelectLevel,
  onOpen,
}: FolderProps) {
  const lean = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const relX = (event.clientX - rect.left) / rect.width - 0.5;
    const relY = (event.clientY - rect.top) / rect.height - 0.5;
    event.currentTarget.style.setProperty("--ry", `${(relX * 7).toFixed(2)}deg`);
    event.currentTarget.style.setProperty("--rx", `${(-relY * 6).toFixed(2)}deg`);
  };
  const unlean = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.style.setProperty("--rx", "0deg");
    event.currentTarget.style.setProperty("--ry", "0deg");
  };

  return (
    <motion.div
      className={`glass-folder gf-${level}`}
      variants={fadeRise}
      custom={index * 0.07}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-40px" }}
    >
      <div className="gf-tilt" onPointerMove={lean} onPointerLeave={unlean}>
        <div
          className="gf-stack"
          {...(people.length === 0 ? { "aria-hidden": true } : {})}
        >
          {people.map((person, i) => (
            <button
              key={person.id}
              type="button"
              className="gf-card"
              style={
                {
                  left: `${6 + i * 16}%`,
                  zIndex: i + 1,
                  "--rot": `${(i - (people.length - 1) / 2) * 3.5}deg`,
                  "--ty": `${12 - i * 3}px`,
                } as React.CSSProperties
              }
              onClick={() => onOpen(person)}
              aria-label={`Открыть клиента ${person.email}: под риском ${money(person.estimatedLoss)}, score ${person.score ?? "—"}`}
            >
              <span className="gf-avatar" aria-hidden="true">
                {(person.email?.trim()?.[0] || "?").toUpperCase()}
              </span>
              <span className="gf-card-copy">
                <span className="gf-card-email" title={person.email}>
                  {person.email}
                </span>
                <span className="gf-card-meta">
                  {level === "unrated"
                    ? "нет оценки"
                    : `${money(person.estimatedLoss)} · score ${person.score ?? "—"}`}
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="gf-body">
          <div className="gf-head">
            <span className="gf-level">
              <span className={`risk-dot risk-dot-${level}`} aria-hidden="true" />
              {RISK_LABELS[level]}
            </span>
            <span className="gf-count">{integer(count)}</span>
          </div>
          {count === 0 ? (
            <div className="gf-empty">
              {level === "unrated" ? "Все клиенты оценены" : "В этой папке пока пусто"}
              <span className="gf-sub">Папка наполнится после следующего снимка.</span>
            </div>
          ) : (
            <>
              <div className="gf-money">{money(loss)}</div>
              <div className="gf-sub">
                выручка под риском · {integer(count)} {customerWord(count)}
                <br />
                {hint}
              </div>
            </>
          )}
          <div className="gf-foot">
            <md-text-button
              onClick={() => onSelectLevel(level)}
              aria-label={`Открыть очередь сегмента «${RISK_LABELS[level]}»`}
            >
              Открыть сегмент →
            </md-text-button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

/**
 * Risk segments as frosted-glass folders (pattern inspired by the
 * glass-folder cards the user shared, rebuilt for this product): each
 * folder leans toward the pointer, its top customers peek out as glass
 * mini-cards and fan wider on hover/focus. Folder counts and money use
 * the loaded top-100 subset (labelled); client counts come from the
 * portfolio summary.
 */
export function GlassFolders({
  summary,
  customers,
  losses,
  onSelectLevel,
  onOpen,
}: GlassFoldersProps) {
  const topByLevel = useMemo(() => {
    const grouped = new Map<RiskLevel, Customer[]>();
    for (const c of customers) {
      const list = grouped.get(c.riskLevel) ?? [];
      list.push(c);
      grouped.set(c.riskLevel, list);
    }
    const result = new Map<RiskLevel, Customer[]>();
    grouped.forEach((list, level) => {
      result.set(
        level,
        [...list]
          .sort(
            (a, b) =>
              b.estimatedLoss - a.estimatedLoss || (b.score ?? 0) - (a.score ?? 0),
          )
          .slice(0, 3),
      );
    });
    return result;
  }, [customers]);

  return (
    <section className="panel glass-folders-panel" aria-label="Папки сегментов риска">
      <div className="panel-heading">
        <div className="section-heading-copy">
          <span className="eyebrow">Сегменты как папки</span>
          <h2>Папки риска</h2>
          <p>
            Каждый сегмент — стеклянная папка, а сверху выглядывают клиенты с самой большой
            выручкой под риском. Наведите курсор — папка наклонится, карточки разойдутся
            веером. Клик по карточке открывает клиента, по кнопке — всю очередь сегмента.
          </p>
        </div>
        <span className="panel-meta">Карточки — по топ-{integer(customers.length)}</span>
      </div>

      <div className="glass-folders-grid">
        {FOLDERS.map((folder, i) => (
          <GlassFolder
            key={folder.level}
            level={folder.level}
            hint={folder.hint}
            count={countFor(summary, folder.level)}
            loss={losses[folder.level]}
            people={topByLevel.get(folder.level) ?? []}
            index={i}
            onSelectLevel={onSelectLevel}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}
