import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditZustandSelectors } from "./zustand-selector-guard";

const APP_SRC_DIR = path.resolve(__dirname, "..");

describe("Zustand selector stability static guard (React #185 prevention)", () => {
  it("flags unstable plain selectors returning fresh objects, arrays, fallback literals, or allocating helpers", () => {
    const violations = auditZustandSelectors({
      rootDir: APP_SRC_DIR,
      extraStoreHooks: ["useSessionStore"],
      virtualFiles: [
        {
          filePath: "helpers.ts",
          content: `
            export function findChild(state: any) {
              return { id: "a", serverId: "s" };
            }
            export function selectSummary(state: any) {
              const existing = findChild(state);
              return { existing, supportsMainChat: Boolean(state.ok) };
            }
            export function selectFlatSlice(state: any) {
              return { ok: Boolean(state.ok) };
            }
          `,
        },
        {
          filePath: "bad.tsx",
          content: `
            import { useShallow } from "zustand/shallow";
            import { useStoreWithEqualityFn } from "zustand/traditional";
            import { shallow } from "zustand/shallow";
            export function BadComponent(hosts: Array<{ serverId: string; label?: string }>) {
              const a = useSessionStore((state) => selectSummary(state));
              const b = useSessionStore((state) =>
                hosts
                  .filter((h) => Boolean(state.sessions[h.serverId]))
                  .map((h) => ({ serverId: h.serverId, label: h.label ?? h.serverId })),
              );
              const c = useSessionStore((state) => state.items ?? []);
              const d = useSessionStore((state) => ({ count: state.count }));
              // Nested fresh allocations still break under useShallow and shallow!
              const e = useSessionStore(useShallow((state) => selectSummary(state)));
              const f = useSessionStore(
                useShallow((state) => hosts.map((h) => ({ serverId: h.serverId }))),
              );
              const g = useStoreWithEqualityFn(
                useSessionStore,
                (state) => hosts.map((h) => ({ serverId: h.serverId })),
                shallow,
              );
              const h = useSessionStore((state) => selectFlatSlice(state));
              return { a, b, c, d, e, f, g, h };
            }
          `,
        },
      ],
    });

    expect(violations.map((v) => `${v.line}:${v.rule}`)).toEqual([
      "6:unstable-plain-selector",
      "7:unstable-plain-selector",
      "12:unstable-plain-selector",
      "13:unstable-plain-selector",
      "15:unstable-shallow-nested-selector",
      "16:unstable-shallow-nested-selector",
      "19:unstable-shallow-nested-selector",
      "24:unstable-plain-selector",
    ]);
  });

  it("allows stable selectors (primitives, direct store refs, flat useShallow, and deep equal)", () => {
    const violations = auditZustandSelectors({
      rootDir: APP_SRC_DIR,
      extraStoreHooks: ["useSessionStore"],
      virtualFiles: [
        {
          filePath: "helpers.ts",
          content: `
            export function findChild(state: any) {
              return { id: "a", serverId: "s" };
            }
            export function selectSummary(state: any) {
              const existing = findChild(state);
              return { existing, supportsMainChat: Boolean(state.ok) };
            }
            export function selectFlatSlice(state: any) {
              return { ok: Boolean(state.ok), client: state.client };
            }
          `,
        },
        {
          filePath: "good.tsx",
          content: `
            import equal from "fast-deep-equal";
            import { useCallback } from "react";
            import { useShallow } from "zustand/shallow";
            import { useStoreWithEqualityFn } from "zustand/traditional";
            export function GoodComponent(hosts: Array<{ serverId: string }>, serverId: string) {
              const a = useStoreWithEqualityFn(
                useSessionStore,
                useCallback((state) => selectSummary(state), []),
                equal,
              );
              const b = useStoreWithEqualityFn(
                useSessionStore,
                (state) => hosts.filter((h) => Boolean(state.sessions[h.serverId])).map((h) => ({ id: h.serverId })),
                equal,
              );
              const c = useSessionStore((state) => selectSummary(state).supportsMainChat);
              const d = useSessionStore(useShallow((state) => selectFlatSlice(state)));
              const e = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
              const f = useSessionStore((state) =>
                Object.entries(state.sessions)
                  .map(([id]) => id)
                  .sort()
                  .join(","),
              );
              return { a, b, c, d, e, f };
            }
          `,
        },
      ],
    });

    expect(violations).toEqual([]);
  });

  it("passes with zero unstable Zustand selectors across all of packages/app/src", () => {
    const violations = auditZustandSelectors({ rootDir: APP_SRC_DIR });
    expect(violations).toEqual([]);
  }, 30_000);
});
