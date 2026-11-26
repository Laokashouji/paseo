import { getDesktopHost } from "@/desktop/host";

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

export async function syncPersonaHubUrlWithMain(
  hubUrl: string | null,
  options?: { enabled?: boolean },
): Promise<boolean> {
  const setter = getDesktopHost()?.persona?.setHubUrl;
  if (typeof setter !== "function") {
    return false;
  }
  try {
    const accepted = await setter(hubUrl, options);
    return accepted === true;
  } catch {
    return false;
  }
}

export async function disableResidentPersonaWebview(): Promise<void> {
  await syncPersonaHubUrlWithMain(null, { enabled: false });
}

export function parkResidentPersonaWebview(): void {
  // No-op outside Electron desktop runtime.
}
