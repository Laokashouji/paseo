import { useCallback, useEffect, useState } from "react";
import { mergeChangelogReleases, parseChangelog, type ChangelogRelease } from "./parse-changelog";

const UPSTREAM_CHANGELOG_URL = "https://raw.githubusercontent.com/getpaseo/paseo/main/CHANGELOG.md";
const DEFAULT_WEBSITE_CHANGELOG_URL = "https://paseo.sh/changelog";

function normalizeEnvUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function resolveForkChangelogUrl(): string | null {
  return normalizeEnvUrl(process.env.EXPO_PUBLIC_FORK_CHANGELOG_URL);
}

export function resolveWebsiteChangelogUrl(): string {
  return (
    normalizeEnvUrl(process.env.EXPO_PUBLIC_CHANGELOG_WEB_URL) ?? DEFAULT_WEBSITE_CHANGELOG_URL
  );
}

export type ChangelogState =
  | { status: "loading" }
  | { status: "ready"; releases: ChangelogRelease[] }
  | { status: "error" };

export interface ChangelogSnapshot {
  forkUrl: string | null;
  forkMarkdown: string | null;
  upstreamMarkdown: string | null;
  releases: ChangelogRelease[];
}

export interface FetchChangelogOptions {
  forkUrl: string | null;
  upstreamUrl?: string;
  previous: ChangelogSnapshot | null;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

// Survives close/reopen so the second look paints without a spinner. Both raw
// documents are kept alongside the merged releases so an unchanged revalidation
// can be dropped and a single-source revalidation blip keeps the other source.
let cached: ChangelogSnapshot | null = null;

export interface Changelog {
  state: ChangelogState;
  reload: () => void;
}

async function fetchMarkdownSource(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`Changelog request failed (${response.status}): ${url}`);
  return response.text();
}

async function fetchUpstreamOnlySnapshot(
  upstreamUrl: string,
  base: ChangelogSnapshot | null,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<ChangelogSnapshot> {
  const markdown = await fetchMarkdownSource(upstreamUrl, signal, fetchImpl);
  if (base?.upstreamMarkdown === markdown) return base;
  const releases = parseChangelog(markdown);
  if (releases.length === 0) throw new Error("Changelog has no releases");
  return {
    forkUrl: null,
    forkMarkdown: null,
    upstreamMarkdown: markdown,
    releases,
  };
}

function materializeMergedSnapshot(input: {
  forkUrl: string;
  base: ChangelogSnapshot | null;
  forkMarkdown: string | null;
  upstreamMarkdown: string | null;
}): ChangelogSnapshot {
  const { forkUrl, base, forkMarkdown, upstreamMarkdown } = input;
  if (base && base.forkMarkdown === forkMarkdown && base.upstreamMarkdown === upstreamMarkdown) {
    return base;
  }

  const forkReleases = forkMarkdown ? parseChangelog(forkMarkdown) : [];
  const upstreamReleases = upstreamMarkdown ? parseChangelog(upstreamMarkdown) : [];
  const releases = mergeChangelogReleases(forkReleases, upstreamReleases);

  if (releases.length === 0) {
    if (base) return base;
    throw new Error("Changelog has no releases");
  }

  return { forkUrl, forkMarkdown, upstreamMarkdown, releases };
}

export async function fetchChangelogSnapshot({
  forkUrl,
  upstreamUrl = UPSTREAM_CHANGELOG_URL,
  previous,
  signal,
  fetchImpl = fetch,
}: FetchChangelogOptions): Promise<ChangelogSnapshot | null> {
  const base = previous && previous.forkUrl === forkUrl ? previous : null;
  if (!forkUrl) {
    return fetchUpstreamOnlySnapshot(upstreamUrl, base, signal, fetchImpl);
  }

  const [forkResult, upstreamResult] = await Promise.allSettled([
    fetchMarkdownSource(forkUrl, signal, fetchImpl),
    fetchMarkdownSource(upstreamUrl, signal, fetchImpl),
  ]);

  if (signal.aborted) return null;

  if (forkResult.status === "rejected" && upstreamResult.status === "rejected") {
    if (base) return base;
    throw new Error("All changelog sources failed");
  }

  return materializeMergedSnapshot({
    forkUrl,
    base,
    forkMarkdown:
      forkResult.status === "fulfilled" ? forkResult.value : (base?.forkMarkdown ?? null),
    upstreamMarkdown:
      upstreamResult.status === "fulfilled"
        ? upstreamResult.value
        : (base?.upstreamMarkdown ?? null),
  });
}

/**
 * Reads the changelog from the repository the app was built from, interleaving
 * fork releases with upstream releases when `EXPO_PUBLIC_FORK_CHANGELOG_URL` is set.
 *
 * The daemon is not involved: the changelog describes the app, a phone reaching
 * a relay already has internet, and going through a host would make the notes
 * depend on which host happens to be connected.
 *
 * Every open refetches, because the whole point of opening it is a release that
 * shipped after this app started. A previous result stays on screen while that
 * happens, and survives a failed revalidation.
 */
export function useChangelog(enabled: boolean): Changelog {
  const forkUrl = resolveForkChangelogUrl();
  const [state, setState] = useState<ChangelogState>(() => readCache(forkUrl));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    setState(readCache(forkUrl));

    void (async () => {
      try {
        const previous = cached?.forkUrl === forkUrl ? cached : null;
        const snapshot = await fetchChangelogSnapshot({
          forkUrl,
          previous,
          signal: controller.signal,
        });
        if (!snapshot || controller.signal.aborted) return;
        if (snapshot === previous) return;
        cached = snapshot;
        setState({ status: "ready", releases: snapshot.releases });
      } catch {
        if (controller.signal.aborted) return;
        if (cached?.forkUrl === forkUrl) return;
        setState({ status: "error" });
      }
    })();

    return () => controller.abort();
  }, [enabled, attempt, forkUrl]);

  const reload = useCallback(() => {
    cached = null;
    setAttempt((value) => value + 1);
  }, []);

  return { state, reload };
}

function readCache(forkUrl: string | null): ChangelogState {
  return cached && cached.forkUrl === forkUrl
    ? { status: "ready", releases: cached.releases }
    : { status: "loading" };
}
