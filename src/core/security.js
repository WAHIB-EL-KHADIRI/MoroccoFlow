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
  const safe = /^[=+\-@]/.test(string) ? `'${string}` : string;
  return `"${safe.replaceAll('"', '""')}"`;
}
