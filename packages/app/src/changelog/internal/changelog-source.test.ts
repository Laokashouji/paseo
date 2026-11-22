import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchChangelogSnapshot,
  resolveForkChangelogUrl,
  resolveWebsiteChangelogUrl,
} from "./changelog-source";

function createResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe("changelog env resolution", () => {
  const originalForkUrl = process.env.EXPO_PUBLIC_FORK_CHANGELOG_URL;
  const originalWebUrl = process.env.EXPO_PUBLIC_CHANGELOG_WEB_URL;

  afterEach(() => {
    if (originalForkUrl === undefined) {
      delete process.env.EXPO_PUBLIC_FORK_CHANGELOG_URL;
    } else {
      process.env.EXPO_PUBLIC_FORK_CHANGELOG_URL = originalForkUrl;
    }
    if (originalWebUrl === undefined) {
      delete process.env.EXPO_PUBLIC_CHANGELOG_WEB_URL;
    } else {
      process.env.EXPO_PUBLIC_CHANGELOG_WEB_URL = originalWebUrl;
    }
  });

  it("defaults to upstream-only URLs when env vars are unset or blank", () => {
    delete process.env.EXPO_PUBLIC_FORK_CHANGELOG_URL;
    delete process.env.EXPO_PUBLIC_CHANGELOG_WEB_URL;
    expect(resolveForkChangelogUrl()).toBeNull();
    expect(resolveWebsiteChangelogUrl()).toBe("https://paseo.sh/changelog");

    process.env.EXPO_PUBLIC_FORK_CHANGELOG_URL = "   ";
    process.env.EXPO_PUBLIC_CHANGELOG_WEB_URL = "  ";
    expect(resolveForkChangelogUrl()).toBeNull();
    expect(resolveWebsiteChangelogUrl()).toBe("https://paseo.sh/changelog");
  });

  it("uses configured fork changelog and release URLs when provided", () => {
    process.env.EXPO_PUBLIC_FORK_CHANGELOG_URL =
      " https://raw.githubusercontent.com/Laokashouji/paseo/fork/FORK_CHANGELOG.md ";
    process.env.EXPO_PUBLIC_CHANGELOG_WEB_URL = " https://github.com/Laokashouji/paseo/releases ";

    expect(resolveForkChangelogUrl()).toBe(
      "https://raw.githubusercontent.com/Laokashouji/paseo/fork/FORK_CHANGELOG.md",
    );
    expect(resolveWebsiteChangelogUrl()).toBe("https://github.com/Laokashouji/paseo/releases");
  });
});

describe("fetchChangelogSnapshot", () => {
  const FORK_URL = "https://example.com/fork/FORK_CHANGELOG.md";
  const UPSTREAM_URL = "https://example.com/upstream/CHANGELOG.md";

  it("fetches only upstream when forkUrl is null", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      createResponse("## 0.17.1 - 2026-11-21\n\n- Upstream\n"),
    );

    const snapshot = await fetchChangelogSnapshot({
      forkUrl: null,
      upstreamUrl: UPSTREAM_URL,
      previous: null,
      signal: new AbortController().signal,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(UPSTREAM_URL, expect.any(Object));
    expect(snapshot?.releases.map((entry) => entry.version)).toEqual(["0.17.1"]);
    expect(snapshot?.releases[0].source).toBeUndefined();
  });

  it("fetches and interleaves fork and upstream changelogs concurrently", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (input === FORK_URL) {
        return createResponse(
          "## 0.17.504 - 2026-11-22\n\n- Fork 504\n\n## 0.17.501 - 2026-11-20\n\n- Fork 501\n",
        );
      }
      return createResponse("## 0.17.1 - 2026-11-21\n\n- Upstream\n");
    });

    const snapshot = await fetchChangelogSnapshot({
      forkUrl: FORK_URL,
      upstreamUrl: UPSTREAM_URL,
      previous: null,
      signal: new AbortController().signal,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(snapshot?.releases.map((entry) => [entry.version, entry.source ?? "upstream"])).toEqual([
      ["0.17.504", "fork"],
      ["0.17.1", "upstream"],
      ["0.17.501", "fork"],
    ]);
  });

  it("falls back to upstream when fork source fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (input === FORK_URL) return createResponse("Not Found", 404);
      return createResponse("## 0.17.1 - 2026-11-21\n\n- Upstream\n");
    });

    const snapshot = await fetchChangelogSnapshot({
      forkUrl: FORK_URL,
      upstreamUrl: UPSTREAM_URL,
      previous: null,
      signal: new AbortController().signal,
      fetchImpl,
    });

    expect(snapshot?.releases.map((entry) => entry.version)).toEqual(["0.17.1"]);
  });

  it("falls back to fork when upstream source fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (input === FORK_URL) {
        return createResponse("## 0.17.504 - 2026-11-22\n\n- Fork 504\n");
      }
      throw new Error("Network down");
    });

    const snapshot = await fetchChangelogSnapshot({
      forkUrl: FORK_URL,
      upstreamUrl: UPSTREAM_URL,
      previous: null,
      signal: new AbortController().signal,
      fetchImpl,
    });

    expect(snapshot?.releases.map((entry) => [entry.version, entry.source])).toEqual([
      ["0.17.504", "fork"],
    ]);
  });

  it("preserves previously cached source when one feed fails during revalidation", async () => {
    const initialFetch = vi.fn<typeof fetch>(async (input) => {
      if (input === FORK_URL) {
        return createResponse("## 0.17.504 - 2026-11-22\n\n- Fork 504\n");
      }
      return createResponse("## 0.17.1 - 2026-11-21\n\n- Upstream\n");
    });
    const first = await fetchChangelogSnapshot({
      forkUrl: FORK_URL,
      upstreamUrl: UPSTREAM_URL,
      previous: null,
      signal: new AbortController().signal,
      fetchImpl: initialFetch,
    });

    const revalidateFetch = vi.fn<typeof fetch>(async (input) => {
      if (input === FORK_URL) {
        return createResponse(
          "## 0.17.505 - 2026-11-22\n\n- Fork 505\n\n## 0.17.504 - 2026-11-22\n\n- Fork 504\n",
        );
      }
      throw new Error("Upstream timeout");
    });
    const second = await fetchChangelogSnapshot({
      forkUrl: FORK_URL,
      upstreamUrl: UPSTREAM_URL,
      previous: first,
      signal: new AbortController().signal,
      fetchImpl: revalidateFetch,
    });

    expect(second?.releases.map((entry) => entry.version)).toEqual([
      "0.17.505",
      "0.17.504",
      "0.17.1",
    ]);
  });

  it("returns the exact previous snapshot reference when neither feed changed", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (input === FORK_URL) {
        return createResponse("## 0.17.504 - 2026-11-22\n\n- Fork 504\n");
      }
      return createResponse("## 0.17.1 - 2026-11-21\n\n- Upstream\n");
    });
    const first = await fetchChangelogSnapshot({
      forkUrl: FORK_URL,
      upstreamUrl: UPSTREAM_URL,
      previous: null,
      signal: new AbortController().signal,
      fetchImpl,
    });
    const second = await fetchChangelogSnapshot({
      forkUrl: FORK_URL,
      upstreamUrl: UPSTREAM_URL,
      previous: first,
      signal: new AbortController().signal,
      fetchImpl,
    });

    expect(second).toBe(first);
  });

  it("throws when both sources fail without a cached snapshot", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => createResponse("Server Error", 500));

    await expect(
      fetchChangelogSnapshot({
        forkUrl: FORK_URL,
        upstreamUrl: UPSTREAM_URL,
        previous: null,
        signal: new AbortController().signal,
        fetchImpl,
      }),
    ).rejects.toThrow("All changelog sources failed");
  });
});
