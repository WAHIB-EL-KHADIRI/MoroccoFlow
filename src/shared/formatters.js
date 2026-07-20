import { getLocale } from "../core/i18n.js";

const moneyFormatters = new Map();
const dateFormatters = new Map();

function localeCode() {
  return getLocale() === "ar" ? "ar-MA" : "fr-MA";
}

export function formatMoney(centimes = 0) {
  if (Number(centimes) === 0) return "0 dh";
  const locale = localeCode();
  if (!moneyFormatters.has(locale)) {
    moneyFormatters.set(
      locale,
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "MAD",
        maximumFractionDigits: 2,
      }),
    );
  }
  return moneyFormatters.get(locale).format(centimes / 100);
}

export function formatDate(date) {
  if (!date) return "-";
  const locale = localeCode();
  if (!dateFormatters.has(locale)) {
    dateFormatters.set(
      locale,
      new Intl.DateTimeFormat(locale, {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }),
    );
  }
  return dateFormatters.get(locale).format(new Date(date));
}

export function initials(name = "") {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export const percent = (value) => `${Math.round(value)}%`;
