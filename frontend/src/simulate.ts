import type { Customer, RiskLevel } from "./types";

/**
 * Client-side mirror of the scoring rules in churnrisk/domain.py, used by
 * the what-if simulator. It only *previews*: saving always goes through
 * PATCH /api/v1/model/settings and the server remains the source of truth.
 * Thresholds come from the API; the revenue factors mirror RISK_FACTORS.
 */
export const RISK_FACTORS: Record<Exclude<RiskLevel, "unrated">, number> = {
  high: 0.8,
  medium: 0.45,
  low: 0.15,
};

export type LevelCounts = Record<RiskLevel, number>;

export interface Mover {
  id: string;
  email: string;
  fromScore: number | null;
  toScore: number;
  fromLevel: RiskLevel;
  toLevel: RiskLevel;
  fromLoss: number;
  toLoss: number;
}

export interface SimulationResult {
  counts: LevelCounts;
  estimatedLoss: number;
  movers: Mover[];
}

function levelFor(score: number, thresholds: Record<string, number>): Exclude<RiskLevel, "unrated"> {
  const high = Number(thresholds?.high ?? 65);
  const medium = Number(thresholds?.medium ?? 35);
  return score >= high ? "high" : score >= medium ? "medium" : "low";
}

export function simulateWeights(
  customers: Customer[],
  weights: Record<string, number>,
  thresholds: Record<string, number>,
): SimulationResult {
  const totalWeight = Object.values(weights).reduce(
    (sum, value) => sum + Math.max(Number(value) || 0, 0),
    0,
  );
  const counts: LevelCounts = { high: 0, medium: 0, low: 0, unrated: 0 };
  const movers: Mover[] = [];
  let estimatedLoss = 0;

  for (const customer of customers) {
    if (customer.score == null) {
      counts.unrated += 1;
      continue;
    }
    const weighted = Object.entries(weights).reduce(
      (sum, [key, weight]) => sum + (customer.features?.[key] ? Math.max(Number(weight) || 0, 0) : 0),
      0,
    );
    const toScore = totalWeight ? Math.round((100 * weighted) / totalWeight) : 0;
    const toLevel = levelFor(toScore, thresholds);
    const available = Number(customer.availableBalance ?? customer.balance) || 0;
    const toLoss = Math.round(
      Math.max(0, (Number(customer.monthlyRevenue) || 0) * 3 - available) * RISK_FACTORS[toLevel],
    );
    counts[toLevel] += 1;
    estimatedLoss += toLoss;
    if (toLevel !== customer.riskLevel) {
      movers.push({
        id: customer.id,
        email: customer.email,
        fromScore: customer.score,
        toScore,
        fromLevel: customer.riskLevel,
        toLevel,
        fromLoss: customer.estimatedLoss,
        toLoss,
      });
    }
  }

  movers.sort((a, b) => Math.abs(b.toLoss - b.fromLoss) - Math.abs(a.toLoss - a.fromLoss));
  return { counts, estimatedLoss, movers };
}

export function lossByLevel(customers: Customer[]): Record<RiskLevel, number> {
  const sums: Record<RiskLevel, number> = { high: 0, medium: 0, low: 0, unrated: 0 };
  for (const customer of customers) {
    sums[customer.riskLevel] += Number(customer.estimatedLoss) || 0;
  }
  return sums;
}
