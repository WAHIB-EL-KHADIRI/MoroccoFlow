export function escapeHTML(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function safeUrl(value = "") {
  try {
    const url = new URL(value, window.location.origin);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : "#";
  } catch {
    return "#";
  }
}

export function csvCell(value = "") {
  const string = String(value);
  // Same set as the API's finance export: spreadsheets also start a formula after a
  // leading tab or carriage return, which the old pattern let through.
  const safe = /^[=+\-@\t\r]/.test(string) ? `'${string}` : string;
  return `"${safe.replaceAll('"', '""')}"`;
}
