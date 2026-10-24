import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import type { ModelSettings } from "../types";
import { integer } from "../format";
import { springEmphasized, staggerChild, staggerParent } from "../motion";
import { ExpressiveSlider } from "./ExpressiveSlider";

interface WeightControlsProps {
  settings: ModelSettings;
  onWeightChange: (key: string, value: number) => void;
}

interface WeightItemProps {
  featureKey: string;
  label: string;
  value: number;
  share: number;
  totalWeight: number;
  onWeightChange: (key: string, value: number) => void;
}

/**
 * One M3 Expressive slider card. The number field keeps local text state
 * while focused so it can be cleared/retyped; the share bar is a scaleX
 * transform (no layout thrash), while the custom slider keeps its exact
 * value visible at rest, on hover, during drag and from the keyboard.
 */
function WeightItem({
  featureKey,
  label,
  value,
  share,
  totalWeight,
  onWeightChange,
}: WeightItemProps) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);

  return (
    <motion.div className="weight-item" variants={staggerChild}>
      <div className="weight-head">
        <label htmlFor={`weight-${featureKey}`} id={`weight-label-${featureKey}`}>
          {label}
        </label>
        <span className="weight-value-chip" aria-hidden="true">
          {integer(value)}
        </span>
      </div>
      <div className="weight-inputs">
        <ExpressiveSlider
          id={`weight-${featureKey}`}
          min={0}
          max={100}
          step={1}
          value={value}
          dataWeight={featureKey}
          label={`Вес сигнала: ${label}`}
          onChange={(next) => onWeightChange(featureKey, next)}
        />
        <input
          className="weight-number"
          type="number"
          min={0}
          max={100}
          step={1}
          value={text}
          data-weight={featureKey}
          aria-label={`Вес признака ${label}`}
          inputMode="numeric"
          onFocus={() => {
            focused.current = true;
          }}
          onChange={(event) => {
            const nextText = event.target.value;
            setText(nextText);
            if (nextText === "" || !event.target.validity.valid) return;
            const next = Number(nextText);
            if (Number.isFinite(next) && next >= 0 && next <= 100) {
              onWeightChange(featureKey, Math.round(next));
            }
          }}
          onBlur={(event) => {
            focused.current = false;
            if (!event.target.validity.valid || event.target.value === "") {
              setText(String(value));
            } else {
              setText(String(Math.round(Number(event.target.value))));
            }
          }}
        />
      </div>
      <div className="weight-share" aria-hidden="true">
        <motion.span
          initial={false}
          animate={{ scaleX: share }}
          transition={springEmphasized}
        />
      </div>
      <span className="weight-share-label">
        {totalWeight
          ? `${Math.round(share * 100)}% от суммарного веса`
          : "все сигналы отключены"}
      </span>
    </motion.div>
  );
}

/**
 * The weight grid. Every change is optimistic in Dashboard state, so the
 * sliders react instantly while scores, rows, donut and hero money
 * re-sort/morph after the debounced save lands.
 */
export function WeightControls({ settings, onWeightChange }: WeightControlsProps) {
  const entries = Object.entries(settings.weights);
  const totalWeight = entries.reduce((sum, [, value]) => sum + Number(value || 0), 0);
  const medium = Number(settings.thresholds?.medium ?? 35);
  const high = Number(settings.thresholds?.high ?? 65);

  return (
    <>
      <motion.div
        className="weight-grid"
        variants={staggerParent}
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, margin: "-40px" }}
      >
        {entries.map(([key, rawValue]) => {
          const value = Math.round(Number(rawValue) || 0);
          return (
            <WeightItem
              key={key}
              featureKey={key}
              label={settings.features[key] || key}
              value={value}
              share={totalWeight ? value / totalWeight : 0}
              totalWeight={totalWeight}
              onWeightChange={onWeightChange}
            />
          );
        })}
      </motion.div>

      <div className="model-footer">
        <span>
          Ноль отключает сигнал. Итоговый score нормируется по сумме заданных весов; это
          объяснимая эвристика, не вероятность.
        </span>
        <div
          className="threshold-scale"
          role="img"
          aria-label={`Пороги риска: низкий от 0 до ${medium - 1}, средний от ${medium} до ${high - 1}, высокий от ${high} до 100`}
        >
          <div className="threshold-bar" aria-hidden="true">
            <motion.span
              className="threshold-seg threshold-seg-low"
              initial={{ scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={{ once: true }}
              transition={{ ...springEmphasized, delay: 0 }}
              style={{ flexGrow: medium }}
            />
            <motion.span
              className="threshold-seg threshold-seg-medium"
              initial={{ scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={{ once: true }}
              transition={{ ...springEmphasized, delay: 0.08 }}
              style={{ flexGrow: high - medium }}
            />
            <motion.span
              className="threshold-seg threshold-seg-high"
              initial={{ scaleX: 0 }}
              whileInView={{ scaleX: 1 }}
              viewport={{ once: true }}
              transition={{ ...springEmphasized, delay: 0.16 }}
              style={{ flexGrow: 100 - high }}
            />
          </div>
          <div className="threshold-labels" aria-hidden="true">
            <span>
              <b>Низкий</b> 0–{medium - 1}
            </span>
            <span>
              <b>Средний</b> {medium}–{high - 1}
            </span>
            <span>
              <b>Высокий</b> {high}–100
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
