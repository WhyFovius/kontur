import { motion } from "framer-motion";
import { integer } from "../format";
import { emphasizedTween } from "../motion";

interface ForecastChartProps {
  forecast?: { days: number[]; counts: number[] };
}

interface Point {
  x: number;
  y: number;
}

function smoothPath(points: Point[]): string {
  if (points.length < 2) return "";
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x} ${p2.y}`;
  }
  return d;
}

/**
 * Renewals horizon chart. The smooth path keeps a constant command
 * structure, so Framer Motion can morph `d` between snapshots while
 * the endpoint dots glide with the same tween.
 */
export function ForecastChart({ forecast }: ForecastChartProps) {
  const counts = (forecast?.counts ?? [0, 0, 0, 0, 0]).slice(0, 5);
  while (counts.length < 5) counts.push(0);
  const axisMax = Math.max(4, Math.ceil(Math.max(4, ...counts) / 4) * 4);
  const axisSteps = [axisMax, axisMax * 0.75, axisMax * 0.5, axisMax * 0.25, 0];

  const x = (index: number) => 16 + index * 192;
  const y = (value: number) => 168 - (value / axisMax) * 148;
  const points = counts.map((value, index) => ({ x: x(index), y: y(value) }));
  const stubEnd: Point = { x: x(0) + 42, y: y(counts[0]) };
  const forecastPoints = [stubEnd, ...points.slice(1)];
  const forecastPath = smoothPath(forecastPoints);
  const areaPath = `${forecastPath} L ${x(4)} 180 L ${stubEnd.x} 180 Z`;

  return (
    <div className="chart-area">
      <div className="chart-axis" aria-hidden="true">
        {axisSteps.map((step, index) => (
          <span key={index}>{integer(step)}</span>
        ))}
      </div>
      <div className="chart-plot">
        <div className="chart-gridlines" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        <svg
          viewBox="0 0 800 180"
          role="img"
          aria-label={`Сейчас ${integer(counts[0])} услуг на продлении; к сроку 30 дней ожидается ${integer(counts[4])} услуг.`}
          aria-describedby="forecastDescription"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="chart-gradient-start" />
              <stop offset="100%" className="chart-gradient-end" />
            </linearGradient>
          </defs>
          <motion.path
            className="chart-area-fill"
            initial={false}
            animate={{ d: areaPath }}
            transition={emphasizedTween}
          />
          <motion.path
            className="chart-fact"
            initial={false}
            animate={{ d: `M ${x(0)} ${y(counts[0])} L ${stubEnd.x} ${stubEnd.y}` }}
            transition={emphasizedTween}
          />
          <motion.path
            className="chart-forecast"
            initial={false}
            animate={{ d: forecastPath }}
            transition={emphasizedTween}
          />
          {[points[0], points[4]].map((point, index) => (
            <motion.circle
              key={index}
              className={index === 0 ? "chart-dot chart-dot-start" : "chart-dot chart-dot-end"}
              r="5"
              initial={false}
              animate={{ cx: point.x, cy: point.y }}
              transition={emphasizedTween}
            />
          ))}
        </svg>
        <div className="chart-labels" aria-hidden="true">
          <span>Сейчас</span>
          <span>7 дн.</span>
          <span>14 дн.</span>
          <span>21 дн.</span>
          <span>30 дн.</span>
        </div>
      </div>
    </div>
  );
}
