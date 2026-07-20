const paths = {
  dashboard:
    '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  projects: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/>',
  finance: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h2"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  team: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 11 2 2 4-4"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55V21h-4v-.08A1.7 1.7 0 0 0 9 19.37a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14H3v-4h.08A1.7 1.7 0 0 0 4.63 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08V3h4v.08A1.7 1.7 0 0 0 15 4.63a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  trend: '<path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  wallet:
    '<path d="M20 7V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h16v12H5a3 3 0 0 1-3-3V6"/><path d="M16 14h2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  arrowLeft: '<path d="m15 18-6-6 6-6"/>',
  arrowRight: '<path d="m9 18 6-6-6-6"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  refresh:
    '<path d="M20 6v5h-5M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6.5L4 11M5.5 15A7 7 0 0 0 18 17.5l2-4.5"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  building: '<path d="M3 21h18M6 21V4h9v17M15 9h3v12M9 8h3M9 12h3M9 16h3"/>',
  alert:
    '<path d="M10.3 3.6 2.1 18a2 2 0 0 0 1.7 3h16.4a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01"/>',
};

export function icon(name, className = "icon") {
  const path = paths[name] || paths.dashboard;
  return `<svg class="${className}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

export const flowMark = () =>
  '<svg aria-hidden="true" viewBox="0 0 32 32" fill="none"><path d="M4 20c4 0 5.5-5.5 9.5-5.5S18 22 22 22s4-4 6-4" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><path d="M4 12c4 0 5-4 9-4s5 6 9 6 4-3 6-3" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" opacity=".65"/></svg>';
