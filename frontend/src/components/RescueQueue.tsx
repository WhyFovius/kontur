import { motion } from "framer-motion";
import { integer, money } from "../format";
import { fadeRise, springEmphasized, springSnappy } from "../motion";
import { MascotImage } from "./Brand";
import type { RescueQueueData, RescueQueueItem, RiskLevel } from "../types";
import {
  IconArrowUpRight,
  IconBolt,
  IconCalendar,
  IconCheck,
  IconShield,
  IconUsers,
  IconWallet,
} from "../icons";

function actionIcon(type: string) {
  if (type === "top_up" || type === "pay_now") return <IconWallet />;
  if (type === "enable_autoprolong") return <IconCalendar />;
  if (type === "winback_call") return <IconUsers />;
  if (type === "fix_payment_method") return <IconCheck />;
  return <IconShield />;
}

function deadlineLabel(item: RescueQueueItem): string {
  if (item.dueInDays == null) return "срок не указан";
  if (item.dueInDays < 0) return "уже просрочено";
  if (item.dueInDays < 1) return "сегодня";
  return `осталось ${integer(Math.ceil(item.dueInDays))} дн.`;
}

export function RescueQueue({
  data,
  onOpenCustomer,
}: {
  data: RescueQueueData | null;
  onOpenCustomer: (id: string, level: RiskLevel) => void;
}) {
  return (
    <motion.section
      className="panel rescue-panel"
      variants={fadeRise}
      custom={0.12}
      initial="hidden"
      animate="show"
      aria-label="Очередь спасения выручки"
    >
      <div className="panel-heading rescue-heading">
        <div className="section-heading-copy">
          <span className="eyebrow">
            <IconBolt /> Backend priority engine
          </span>
          <h2>Очередь спасения</h2>
          <p>
            Сервер сам выбирает следующее действие, дедлайн и цену вопроса.
            Сначала — где один контакт спасает больше всего денег в день.
          </p>
        </div>
        <span className="rescue-heading-side">
          <span className="rescue-mascot" aria-hidden="true">
            <MascotImage pose={data?.items.length ? "business" : "calm"} />
          </span>
          <span className="rescue-live" role="status">
            <i aria-hidden="true" /> live
          </span>
        </span>
      </div>

      {!data ? (
        <div className="queue-skeletons" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="row-skeleton">
              <span className="skeleton skeleton-avatar" />
              <span className="skeleton skeleton-line skeleton-line-wide" />
              <span className="skeleton skeleton-pill" />
            </div>
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <div className="rescue-empty">
          <strong>Срочных спасений нет.</strong>
          <span>Монитор продолжает следить за ростом скора и ближайшими продлениями.</span>
        </div>
      ) : (
        <>
          <div className="rescue-totals" aria-label="Итоги очереди спасения">
            <span>
              Ценность очереди <strong>{money(data.totals.rescueValue)}</strong>
            </span>
            <span>
              Топ-3 действия <strong>{money(data.totals.top3RescueValue)}</strong>
            </span>
            <span>
              Нужно пополнений <strong>{money(data.totals.requiredTopUps)}</strong>
            </span>
            <span>
              Критичных клиентов <strong>{integer(data.totals.criticalCustomers)}</strong>
            </span>
          </div>

          <div className="rescue-list" role="list">
            {data.items.map((item) => (
              <motion.button
                key={item.customerId}
                type="button"
                className="rescue-row"
                role="listitem"
                onClick={() => onOpenCustomer(item.customerId, item.riskLevel)}
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.995 }}
                transition={springSnappy}
                aria-label={`Открыть ${item.email}. ${item.actionLabel}. Приоритет ${item.priorityIndex} из 100.`}
              >
                <span className="rescue-rank" aria-hidden="true">{item.rank}</span>
                <span className="rescue-action-icon" aria-hidden="true">
                  {actionIcon(item.actionType)}
                </span>
                <span className="rescue-copy">
                  <span className="rescue-title-row">
                    <strong>{item.email}</strong>
                    <span className={`rescue-score risk-text-${item.riskLevel}`}>
                      {integer(item.score)}
                      {item.predictedScoreAfterAction != null &&
                      item.predictedScoreAfterAction !== item.score
                        ? ` → ${integer(item.predictedScoreAfterAction)}`
                        : ""}
                    </span>
                  </span>
                  <span className="rescue-action">{item.actionLabel}</span>
                  <span className="rescue-detail">{item.actionDetail}</span>
                  <span className="rescue-meter" aria-hidden="true">
                    <motion.span
                      initial={false}
                      animate={{ scaleX: item.priorityIndex / 100 }}
                      transition={springEmphasized}
                    />
                  </span>
                </span>
                <span className="rescue-side">
                  <strong>{money(item.rescueValue)}</strong>
                  <span>{money(item.valuePerDay)} / день</span>
                  <span className="rescue-deadline">
                    {deadlineLabel(item)}
                    {item.requiredTopUp ? ` · нужно ${money(item.requiredTopUp)}` : ""}
                  </span>
                  <span className="rescue-confidence">
                    уверенность {integer(item.confidenceScore)}%
                  </span>
                </span>
                <span className="rescue-open" aria-hidden="true">
                  <IconArrowUpRight />
                </span>
              </motion.button>
            ))}
          </div>
          <p className="panel-hint">{data.method}</p>
        </>
      )}
    </motion.section>
  );
}
