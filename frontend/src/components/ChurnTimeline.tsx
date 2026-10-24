import { motion } from "framer-motion";
import type { ChurnTimelineData } from "../types";
import { integer } from "../format";
import { fadeRise, springEmphasized } from "../motion";

const decimal = (value: number) => value.toFixed(1).replace(".", ",");

/**
 * Fact vs forecast churn dynamics (bonus acceptance chart).
 *
 * Left of the "сегодня" divider: solid bars — services that were
 * actually deleted in the last 90 days (deletedAt, falling back to
 * expiresAt). Right: hatched bars — services at risk in the coming
 * buckets, with a dot marker for the risk-weighted expected
 * non-renewals. Fact and forecast can never be confused: different
 * fill treatment, different legend entries, and a hard divider.
 *
 * Bars animate by transform only (scaleY), so the chart stays on the
 * compositor at the display's native refresh rate.
 */
export function ChurnTimeline({ data }: { data: ChurnTimelineData | null }) {
  if (!data) return null;
  const max = Math.max(
    1,
    ...data.past.map((b) => b.deleted),
    ...data.future.map((b) => b.servicesAtRisk),
  );
  const barScale = (value: number) => Math.max(0.015, value / max);
  const allZero =
    data.totals.deleted90d === 0 && data.totals.servicesAtRisk90d === 0;

  return (
    <motion.article
      className="panel churn-timeline-panel"
      variants={fadeRise}
      custom={0.2}
      initial="hidden"
      animate="show"
      aria-label="Динамика оттока услуг: исторические удаления и прогноз непродлений"
    >
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Факт и прогноз</span>
          <h2>Динамика оттока услуг</h2>
        </div>
        <div className="churn-timeline-legend" aria-hidden="true">
          <span>
            <i className="churn-swatch churn-swatch-fact" /> Факт: удаления
          </span>
          <span>
            <i className="churn-swatch churn-swatch-forecast" /> Прогноз: услуги под риском
          </span>
          <span>
            <i className="churn-swatch churn-swatch-expected" /> Ожидаемые непродления
          </span>
        </div>
      </div>

      <div className="churn-timeline-chart" role="img" aria-label={allZero ? "Удалений за последние 90 дней нет, услуг под риском на ближайшие 90 дней нет." : `За 90 дней удалено услуг: ${data.totals.deleted90d}. В ближайшие 30 дней под риском ${data.totals.servicesAtRisk30d} услуг, ожидаемые непродления: ${decimal(data.totals.expectedNonRenewals30d)}.`}>
        {data.past.map((bucket, index) => (
          <div key={`past-${bucket.fromDays}`} className="churn-col">
            <span className="churn-value">{integer(bucket.deleted)}</span>
            <span className="churn-track">
              <motion.span
                className="churn-bar churn-bar-fact"
                initial={{ scaleY: 0 }}
                whileInView={{ scaleY: barScale(bucket.deleted) }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ ...springEmphasized, delay: index * 0.05 }}
              />
            </span>
            <span className="churn-label">{bucket.label}</span>
          </div>
        ))}

        <div className="churn-divider" aria-hidden="true">
          <span>сегодня</span>
        </div>

        {data.future.map((bucket, index) => (
          <div key={`future-${bucket.fromDays}`} className="churn-col">
            <span className="churn-value">
              {integer(bucket.servicesAtRisk)}
              <small>≈{decimal(bucket.expectedNonRenewals)}</small>
            </span>
            <span className="churn-track">
              <motion.span
                className="churn-bar churn-bar-forecast"
                initial={{ scaleY: 0 }}
                whileInView={{ scaleY: barScale(bucket.servicesAtRisk) }}
                viewport={{ once: true, margin: "-40px" }}
                transition={{ ...springEmphasized, delay: 0.15 + index * 0.05 }}
              />
              {bucket.servicesAtRisk > 0 && (
                <span
                  className="churn-expected-dot"
                  style={{ bottom: `${(bucket.expectedNonRenewals / max) * 100}%` }}
                />
              )}
            </span>
            <span className="churn-label">{bucket.label}</span>
          </div>
        ))}
      </div>

      <div className="churn-timeline-totals">
        <span>
          Удалено за 90 дней: <strong>{integer(data.totals.deleted90d)}</strong>
        </span>
        <span>
          Под риском (30 дней): <strong>{integer(data.totals.servicesAtRisk30d)}</strong>
        </span>
        <span>
          Ожидаемые непродления (30 дней):{" "}
          <strong>≈{decimal(data.totals.expectedNonRenewals30d)}</strong>
        </span>
      </div>
      <p className="panel-hint">{data.method}</p>
    </motion.article>
  );
}
