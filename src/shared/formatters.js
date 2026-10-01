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

/**
 * Parses a typed MAD amount ("1 250,5", "1250.50", "20000") into integer centimes
 * from the digits themselves, never through a float. Returns null for anything that
 * is not a non-negative amount with at most two decimals.
 */
export function parseMoney(input) {
  const text = String(input ?? "")
    .trim()
    // Arabic-Indic and Persian digits, and the Arabic decimal/thousands separators,
    // as typed on an Arabic keyboard.
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[\s\u00a0\u202f\u066c]/g, "")
    .replace(/[,\u066b]/, ".");
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(text);
  if (!match) return null;
  const centimes = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  return Number.isSafeInteger(centimes) ? centimes : null;
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
