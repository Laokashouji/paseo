import {
  isAllowedPersonaTargetOrigin,
  isAllowedPersonaWebviewUrl,
  parsePersonaSessionPath,
  PERSONA_WEBVIEW_PARTITION,
  type ParsedPersonaSessionPath,
} from "./policy.js";

export {
  isAllowedPersonaTargetOrigin,
  isAllowedPersonaWebviewUrl,
  isPersonaWebviewAttach,
  parsePersonaSessionPath,
  PERSONA_OPEN_SESSION_EVENT,
  PERSONA_OPEN_SESSION_EVENT_NAME,
  PERSONA_WEBVIEW_PARTITION,
  type ParsedPersonaSessionPath,
  type PersonaWebviewAttachParams,
} from "./policy.js";

const PERSONA_STORAGE_TYPES = [
  "cookies",
  "filesystem",
  "indexdb",
  "localstorage",
  "serviceworkers",
  "cachestorage",
  "shadercache",
] as const;

export interface PersonaWebviewSession {
  clearStorageData(options: {
    storages: Array<(typeof PERSONA_STORAGE_TYPES)[number]>;
  }): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
}

export interface PersonaWebviewGuest {
  readonly id: number;
  isDestroyed(): boolean;
  reload(): void;
}

export interface PersonaWebviewContentsLike extends PersonaWebviewGuest {
  readonly session: object;
  getType(): string;
}

export interface PersonaWebviewSessionsLike {
  fromPartition(partition: string): PersonaWebviewSession;
}

export interface PersonaWindowOpenSessionPayload extends ParsedPersonaSessionPath {
  source: "window-open";
  rawHref: string;
}

export interface PersonaNavigationEvent {
  url: string;
  isMainFrame?: boolean;
  preventDefault(): void;
}

export interface PersonaGuardableWebContents {
  getURL(): string;
  on(event: "will-navigate", listener: (event: PersonaNavigationEvent, url?: string) => void): void;
  on(
    event: "will-frame-navigate",
    listener: (event: PersonaNavigationEvent, url?: string) => void,
  ): void;
  on(event: "will-redirect", listener: (event: PersonaNavigationEvent, url?: string) => void): void;
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: "deny" } | { action: "allow" },
  ): void;
}

export interface PersonaNavigationGuardDeps {
  getConfiguredHubUrl(): string;
  onOpenSession(payload: PersonaWindowOpenSessionPayload): void;
  openExternalUrl(url: string): Promise<void> | void;
  logWarn?: (message: string, details?: unknown) => void;
}

export function getPersonaWebviewSession(
  sessions: PersonaWebviewSessionsLike,
): PersonaWebviewSession {
  return sessions.fromPartition(PERSONA_WEBVIEW_PARTITION);
}

export function listPersonaWebviewGuests(input: {
  personaSession: object;
  webContents: PersonaWebviewContentsLike[];
}): PersonaWebviewGuest[] {
  return input.webContents.filter(
    (contents) =>
      !contents.isDestroyed() &&
      (contents.getType() === "webview" || contents.getType() === "window") &&
      contents.session === input.personaSession,
  );
}

export async function clearPersonaWebviewSession(input: {
  personaSession: PersonaWebviewSession;
  listGuests(): PersonaWebviewGuest[];
  logReloadError(guestId: number, error: unknown): void;
}): Promise<void> {
  await Promise.all([
    input.personaSession.clearStorageData({ storages: [...PERSONA_STORAGE_TYPES] }),
    input.personaSession.clearCache(),
    input.personaSession.clearAuthCache(),
  ]);

  for (const guest of input.listGuests()) {
    if (guest.isDestroyed()) {
      continue;
    }
    try {
      guest.reload();
    } catch (error) {
      input.logReloadError(guest.id, error);
    }
  }
}

function readEffectiveHubUrl(
  contents: PersonaGuardableWebContents,
  deps: PersonaNavigationGuardDeps,
): string {
  const configured = deps.getConfiguredHubUrl().trim();
  if (configured.length > 0) {
    return configured;
  }
  return contents.getURL().trim();
}

function openExternalSafely(url: string, deps: PersonaNavigationGuardDeps): void {
  try {
    const result = deps.openExternalUrl(url);
    if (result && typeof (result as Promise<void>).catch === "function") {
      void (result as Promise<void>).catch((error) => {
        deps.logWarn?.("[persona-webview] failed to open external url", { error });
      });
    }
  } catch (error) {
    deps.logWarn?.("[persona-webview] failed to open external url", { error });
  }
}

export function registerPersonaWebviewNavigationGuards(
  contents: PersonaGuardableWebContents,
  deps: PersonaNavigationGuardDeps,
): void {
  const guardTopLevelNavigation = (event: PersonaNavigationEvent, fallbackUrl?: string): void => {
    const targetUrl = event.url || fallbackUrl;
    if (!isAllowedPersonaWebviewUrl(targetUrl)) {
      event.preventDefault();
      return;
    }
    const configuredHubUrl = readEffectiveHubUrl(contents, deps);
    if (
      configuredHubUrl &&
      targetUrl &&
      targetUrl !== "about:blank" &&
      !isAllowedPersonaTargetOrigin(targetUrl, configuredHubUrl)
    ) {
      event.preventDefault();
      openExternalSafely(targetUrl, deps);
    }
  };

  contents.on("will-navigate", (event, url) => {
    guardTopLevelNavigation(event, url);
  });

  contents.on("will-redirect", (event, url) => {
    guardTopLevelNavigation(event, url);
  });

  contents.on("will-frame-navigate", (event, url) => {
    const targetUrl = event.url || url;
    if (!isAllowedPersonaWebviewUrl(targetUrl)) {
      event.preventDefault();
      return;
    }
    if (event.isMainFrame !== false) {
      guardTopLevelNavigation(event, targetUrl);
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedPersonaWebviewUrl(url)) {
      return { action: "deny" };
    }
    const configuredHubUrl = readEffectiveHubUrl(contents, deps);
    const parsedSession = configuredHubUrl ? parsePersonaSessionPath(url, configuredHubUrl) : null;
    if (parsedSession) {
      deps.onOpenSession({
        ...parsedSession,
        source: "window-open",
        rawHref: url,
      });
      return { action: "deny" };
    }
    if (url !== "about:blank") {
      openExternalSafely(url, deps);
    }
    return { action: "deny" };
  });
}
