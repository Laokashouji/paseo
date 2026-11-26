export interface PersonaGuestConfigMessage {
  hubOrigin: string;
  hubBasePath: string;
  hidePersonaSidebar: boolean;
  interceptSessionClicks: boolean;
  labels: {
    openInPaseo: string;
    openDiffInPaseo: string;
    openInPaseoTooltip: string;
    openDiffTooltip: string;
  };
}

export function reloadResidentPersonaWebview(): void {
  // No-op outside Electron desktop runtime.
}

export function destroyResidentPersonaWebview(): void {
  // No-op outside Electron desktop runtime.
}

export function parkResidentPersonaWebview(): void {
  // No-op outside Electron desktop runtime.
}
