const moneyFormat = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const integerFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const pluralRules = new Intl.PluralRules("ru-RU");

/** Eurocents -> "1 234,56 €" (API contract: money travels in eurocents). */
export const money = (cents: number | null | undefined): string =>
  moneyFormat.format((Number(cents) || 0) / 100);

export const integer = (value: number | null | undefined): string =>
  integerFormat.format(Number(value) || 0);

const CUSTOMER_WORDS: Record<Intl.LDMLPluralRule, string> = {
  zero: "клиентов",
  one: "клиент",
  two: "клиента",
  few: "клиента",
  many: "клиентов",
  other: "клиентов",
};

export const customerWord = (value: number): string =>
  CUSTOMER_WORDS[pluralRules.select(Number(value) || 0)];

export const dateLabel = (iso: string): string => {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleDateString("ru-RU");
};

export const todayLabel = (): string =>
  new Intl.DateTimeFormat("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());

export const timeLabel = (): string =>
  new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
