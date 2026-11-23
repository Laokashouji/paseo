/**
 * Compact, locale-agnostic formatters for Main Chat token consumption and night-mode schedules.
 */
export function formatCompactTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 ? millions.toFixed(1) : millions.toFixed(2)}M`;
  }
  if (tokens >= 1_000) {
    const thousands = tokens / 1_000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}K`;
  }
  return String(Math.round(tokens));
}

export function formatTokenCostUsd(costUsd: number): string {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return "$0.00";
  if (costUsd < 0.01) return "<$0.01";
  return `$${costUsd.toFixed(2)}`;
}

export function formatNightWindowHours(startHour: number, endHour: number): string {
  const pad = (hour: number) =>
    `${String(((Math.trunc(hour) % 24) + 24) % 24).padStart(2, "0")}:00`;
  return `${pad(startHour)} – ${pad(endHour)}`;
}
