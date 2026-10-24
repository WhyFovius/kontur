export type RiskLevel = "high" | "medium" | "low" | "unrated";
export type SortKey = "id" | "email" | "balance" | "totalReplenished" | "score";
export type SortOrder = "asc" | "desc";

export interface ServiceItem {
  id?: string;
  name?: string;
  status?: string;
  price?: number;
  paymentTerm?: string;
  autoprolong?: boolean;
  expiresAt?: string;
  deletedAt?: string;
}

export interface Customer {
  id: string;
  email: string;
  balance: number;
  availableBalance?: number | null;
  totalReplenished: number;
  score: number | null;
  riskLevel: RiskLevel;
  reasons: string[];
  services: ServiceItem[];
  features: Record<string, boolean>;
  estimatedLoss: number;
  monthlyRevenue: number;
  daysToExpiry?: number | null;
}

export interface CustomerList {
  items: Customer[];
  total: number;
}

export interface Summary {
  customerCount: number;
  ratedCount: number;
  unratedCount: number;
  highRisk: number;
  mediumRisk: number;
  lowRisk: number;
  estimatedLoss: number;
  monthlyRevenueAtRisk: number;
  atRiskServices: number;
  churnForecast: { days: number[]; counts: number[] };
  currency?: string;
  unit?: string;
}

export interface ChurnPastBucket {
  label: string;
  fromDays: number;
  toDays: number;
  deleted: number;
}

export interface ChurnFutureBucket {
  label: string;
  fromDays: number;
  toDays: number;
  servicesAtRisk: number;
  expectedNonRenewals: number;
}

export interface ChurnTimelineData {
  generatedAt: string;
  past: ChurnPastBucket[];
  future: ChurnFutureBucket[];
  totals: {
    deletedServices: number;
    deleted90d: number;
    servicesAtRisk30d: number;
    expectedNonRenewals30d: number;
    servicesAtRisk90d: number;
    expectedNonRenewals90d: number;
  };
  method: string;
}

export interface ModelSettings {
  weights: Record<string, number>;
  features: Record<string, string>;
  thresholds: Record<string, number>;
  horizonMonths: number;
}

export const RISK_LABELS: Record<RiskLevel, string> = {
  high: "Высокий",
  medium: "Средний",
  low: "Низкий",
  unrated: "Нет оценки",
};

export const SERVICE_STATUS_LABELS: Record<string, string> = {
  active: "Активна",
  suspended: "Приостановлена",
  prolong_wait: "Ожидает оплаты",
  deleted: "Удалена",
  blocked: "Заблокирована",
};

export const PAYMENT_LABELS: Record<string, string> = {
  hour: "почасово",
  week: "еженедельно",
  month: "ежемесячно",
  quarter_year: "раз в три месяца",
  half_year: "раз в полгода",
  year: "ежегодно",
};
