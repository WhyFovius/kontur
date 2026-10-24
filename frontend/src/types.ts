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

export type AlertSeverity = "critical" | "warning" | "info";

export interface RiskNotification {
  id: number;
  episodeKey: string;
  customerId: string | null;
  customerEmail: string | null;
  type: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  score: number | null;
  riskLevel: RiskLevel | null;
  estimatedLoss: number;
  daysToExpiry: number | null;
  requiredTopUp: number | null;
  source?: string;
  mode?: "LIVE" | "DEMO";
  eventId?: string | null;
  previousScore?: number | null;
  riskDelta?: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  readAt: string | null;
  resolvedAt: string | null;
  isRead: boolean;
}

export interface NotificationList {
  items: RiskNotification[];
  total: number;
  unreadCount: number;
  criticalCount: number;
  generatedAt: string;
}

export interface NotificationReadResult {
  ok: true;
  notification: RiskNotification | null;
  updatedCount: number;
  unreadCount: number;
}

export interface RescueQueueItem {
  rank: number;
  customerId: string;
  email: string;
  score: number;
  riskLevel: RiskLevel;
  estimatedLoss: number;
  monthlyRevenue: number;
  rescueValue: number;
  valuePerDay: number;
  priorityIndex: number;
  actionType: string;
  actionLabel: string;
  actionDetail: string;
  requiredTopUp: number | null;
  deadlineAt: string | null;
  dueInDays: number | null;
  serviceName: string | null;
  predictedScoreAfterAction: number | null;
  confidence: "high" | "medium" | "low";
  confidenceScore: number;
  reasons: string[];
}

export interface RescueQueueData {
  generatedAt: string;
  items: RescueQueueItem[];
  totals: {
    eligibleCustomers: number;
    criticalCustomers: number;
    rescueValue: number;
    top3RescueValue: number;
    requiredTopUps: number;
  };
  method: string;
}

export type DemoScenario =
  | "NORMAL_ACTIVITY"
  | "ACTIVITY_DROP"
  | "CHURN_RISK_SPIKE"
  | "HIGH_RISK_THRESHOLD"
  | "CUSTOMER_RECOVERY"
  | "NEW_CUSTOMER_ACTIVITY";

export interface ReactionAction {
  id: number;
  eventId: string;
  templateId: string;
  customerId: string | null;
  channel: string;
  recipient: string | null;
  subject: string;
  body: string;
  status: string;
  mode: string;
  createdAt: string;
  sentAt: string | null;
  error: string | null;
}

export interface RealtimeEvent {
  id: number;
  eventId: string;
  type: string;
  source: string;
  mode: "LIVE" | "DEMO";
  scenario: string | null;
  customerId: string | null;
  customerEmail: string | null;
  timestamp: string;
  severity: AlertSeverity;
  previousRiskScore: number | null;
  riskScore: number;
  riskPercent: number;
  riskLevel: RiskLevel;
  riskDelta: number;
  reason: string;
  reasons: string[];
  details: Record<string, unknown>;
  processed: boolean;
  notificationCreated: boolean;
  notificationId: number | null;
  suppressedReason: string | null;
  actions: ReactionAction[];
  duplicate?: boolean;
  createdAt: string;
}

export interface RealtimeEventList {
  items: RealtimeEvent[];
  total: number;
  latestId: number;
  generatedAt: string;
}

export interface RiskCalculation {
  eventId: string;
  baseScore: number | null;
  demoModifier: number;
  previousRiskScore: number | null;
  riskScore: number;
  riskPercent: number;
  riskLevel: RiskLevel;
  riskDelta: number;
  reasons: string[];
  source: string;
  mode: string;
  isDemo: boolean;
  calculatedAt: string;
}

export interface CustomerRealtimeHistory {
  customerId: string;
  events: RealtimeEvent[];
  calculations: RiskCalculation[];
}

export interface RealtimeSourceStatus {
  name: string;
  label: string;
  configured: boolean;
  available: boolean;
  mode: string;
  message: string;
}

export interface SimulatorStatus {
  running: boolean;
  intervalSeconds: number;
  scenario: string;
  generatedCount: number;
  lastEventId: string | null;
  lastError: string | null;
  startedAt: string | null;
}

export interface RealtimeStatus {
  generatedAt: string;
  sources: RealtimeSourceStatus[];
  simulator: SimulatorStatus;
  scenarios: { id: DemoScenario; label: string }[];
  thresholds: {
    medium: number;
    high: number;
    critical: number;
    significantDelta: number;
    notificationCooldownSeconds: number;
  };
  eventCounts: { total: number; demo: number; live: number };
  trackedCustomers: number;
  liveAvailable: boolean;
}

export interface RealtimeDashboardData {
  generatedAt: string;
  periodHours: number;
  trackedCustomers: number;
  highRiskCustomers: number;
  eventsInPeriod: number;
  criticalEvents: number;
  averageRiskPercent: number;
  improvedCustomers: number;
  distribution: { high: number; medium: number; low: number };
  riskSeries: { label: string; value: number }[];
  eventSeries: { label: string; value: number }[];
  method: string;
}

export interface ReactionTemplate {
  id: string;
  name: string;
  triggerTypes: string[];
  minSeverity: AlertSeverity;
  channelStrategy: string;
  subject: string;
  body: string;
  enabled: boolean;
  cooldownSeconds: number;
  priority: number;
  updatedAt: string;
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
