import { getDesktopHost, type DesktopPersonaHubPartitionEntry } from "@/desktop/host";

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

export function reloadResidentPersonaWebview(_hubId?: string): void {
  // No-op outside Electron desktop runtime.
}

export function destroyResidentPersonaWebview(_hubId?: string): void {
  // No-op outside Electron desktop runtime.
}

export function reconcileResidentPersonaWebviews(
  _hubs: ReadonlyArray<{ id: string; hubUrl: string }>,
): void {
  // No-op outside Electron desktop runtime.
}

export async function syncPersonaHubEntriesWithMain(
  entries: readonly DesktopPersonaHubPartitionEntry[] | null,
  options?: { enabled?: boolean },
): Promise<boolean> {
  const personaBridge = getDesktopHost()?.persona;
  if (!personaBridge) {
    return false;
  }
  const normalizedEntries = Array.isArray(entries)
    ? entries
        .map((entry) => ({
          partition: entry.partition.trim(),
          hubUrl: entry.hubUrl.trim(),
        }))
        .filter((entry) => entry.partition.length > 0 && entry.hubUrl.length > 0)
    : [];
  try {
    if (
      personaBridge.supportsPerHubPartitions === true &&
      typeof personaBridge.setHubEntries === "function"
    ) {
      const accepted = await personaBridge.setHubEntries(
        normalizedEntries.length > 0 ? normalizedEntries : null,
        options,
      );
      return accepted === true;
    }
    const urls = Array.from(new Set(normalizedEntries.map((entry) => entry.hubUrl)));
    if (typeof personaBridge.setHubUrls === "function") {
      const accepted = await personaBridge.setHubUrls(urls.length > 0 ? urls : null, options);
      return accepted === true;
    }
    if (typeof personaBridge.setHubUrl === "function") {
      const accepted = await personaBridge.setHubUrl(urls[0] ?? null, options);
      return accepted === true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function syncPersonaHubUrlsWithMain(
  hubUrls: readonly string[] | null,
  options?: { enabled?: boolean },
): Promise<boolean> {
  const personaBridge = getDesktopHost()?.persona;
  if (!personaBridge) {
    return false;
  }
  const normalizedList = Array.isArray(hubUrls)
    ? hubUrls.map((url) => url.trim()).filter((url) => url.length > 0)
    : [];
  try {
    if (typeof personaBridge.setHubUrls === "function") {
      const accepted = await personaBridge.setHubUrls(
        normalizedList.length > 0 ? normalizedList : null,
        options,
      );
      return accepted === true;
    }
    if (typeof personaBridge.setHubUrl === "function") {
      const accepted = await personaBridge.setHubUrl(normalizedList[0] ?? null, options);
      return accepted === true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function syncPersonaHubUrlWithMain(
  hubUrl: string | null,
  options?: { enabled?: boolean },
): Promise<boolean> {
  return syncPersonaHubUrlsWithMain(hubUrl ? [hubUrl] : null, options);
}

export async function disableResidentPersonaWebview(): Promise<void> {
  await syncPersonaHubEntriesWithMain(null, { enabled: false });
}

export function parkResidentPersonaWebview(_hubId?: string): void {
  // No-op outside Electron desktop runtime.
}

export function setResidentPersonaWebviewsInteractive(_interactive: boolean): void {
  // No-op outside Electron desktop runtime.
}
