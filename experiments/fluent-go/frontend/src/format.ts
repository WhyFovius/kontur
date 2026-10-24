const eur = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const int = new Intl.NumberFormat("ru-RU");

/** Money arrives as integer eurocents. */
export function money(cents: number): string {
  return eur.format((Number(cents) || 0) / 100);
}

export function integer(value: number): string {
  return int.format(Math.round(Number(value) || 0));
}

export function decimal(value: number): string {
  return (Number(value) || 0).toFixed(1).replace(".", ",");
}

export function daysLabel(days: number | null | undefined): string {
  if (days == null) return "—";
  if (days < 0) return "просрочено";
  if (days === 0) return "сегодня";
  const whole = Math.floor(days);
  if (whole <= 0) return "сегодня";
  const mod10 = whole % 10;
  const mod100 = whole % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? "день"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "дня"
        : "дней";
  return `${whole} ${word}`;
}
