import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_NAV_MAX_ROWS_COMPACT,
  DEFAULT_SIDEBAR_NAV_MAX_ROWS_WIDE,
  partitionSidebarNavItems,
  resolveDefaultSidebarNavMaxHeight,
  resolveEffectiveSidebarNavMaxHeight,
  resolveSidebarNavBounds,
  resolveSidebarNavMetrics,
  resolveUnitRowHeight,
} from "./sidebar-nav-overflow-layout";

function makeKeys(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `item-${i}`);
}

describe("sidebar nav overflow layout", () => {
  const desktop = resolveSidebarNavMetrics({ compact: false, touchSized: false });

  it("shows all items with no overflow when total height fits within default cap", () => {
    const defaultMaxHeight = resolveDefaultSidebarNavMaxHeight({
      unitRowHeight: desktop.defaultRowHeight,
      slotCount: DEFAULT_SIDEBAR_NAV_MAX_ROWS_WIDE,
      rowGap: desktop.rowGap,
      paddingTop: desktop.paddingTop,
      paddingBottom: desktop.paddingBottom,
    });
    expect(defaultMaxHeight).toBe(184);

    // 4 builtins fit comfortably.
    expect(
      partitionSidebarNavItems({
        itemKeys: makeKeys(4),
        measuredHeights: {},
        defaultRowHeight: desktop.defaultRowHeight,
        rowGap: desktop.rowGap,
        paddingTop: desktop.paddingTop,
        paddingBottom: desktop.paddingBottom,
        overflowTriggerHeight: desktop.defaultRowHeight,
        maxHeight: defaultMaxHeight,
      }),
    ).toEqual({
      visibleCount: 4,
      overflowCount: 0,
      fullContentHeight: 124,
      fittedHeight: 124,
    });

    // Exactly 6 items fit without wasting a slot on a "More (1)" button.
    expect(
      partitionSidebarNavItems({
        itemKeys: makeKeys(6),
        measuredHeights: {},
        defaultRowHeight: desktop.defaultRowHeight,
        rowGap: desktop.rowGap,
        paddingTop: desktop.paddingTop,
        paddingBottom: desktop.paddingBottom,
        overflowTriggerHeight: desktop.defaultRowHeight,
        maxHeight: defaultMaxHeight,
      }),
    ).toEqual({
      visibleCount: 6,
      overflowCount: 0,
      fullContentHeight: 184,
      fittedHeight: 184,
    });
  });

  it("partitions long lists cleanly with 5 inline items + overflow trigger by default", () => {
    const defaultMaxHeight = resolveDefaultSidebarNavMaxHeight({
      unitRowHeight: desktop.defaultRowHeight,
      slotCount: DEFAULT_SIDEBAR_NAV_MAX_ROWS_WIDE,
      rowGap: desktop.rowGap,
      paddingTop: desktop.paddingTop,
      paddingBottom: desktop.paddingBottom,
    });

    expect(
      partitionSidebarNavItems({
        itemKeys: makeKeys(12),
        measuredHeights: {},
        defaultRowHeight: desktop.defaultRowHeight,
        rowGap: desktop.rowGap,
        paddingTop: desktop.paddingTop,
        paddingBottom: desktop.paddingBottom,
        overflowTriggerHeight: desktop.defaultRowHeight,
        maxHeight: defaultMaxHeight,
      }),
    ).toEqual({
      visibleCount: 5,
      overflowCount: 7,
      fullContentHeight: 364,
      fittedHeight: 184,
    });

    // 7 items overflows 2 items (never replaces 1 equal-height item with "More (1)").
    expect(
      partitionSidebarNavItems({
        itemKeys: makeKeys(7),
        measuredHeights: {},
        defaultRowHeight: desktop.defaultRowHeight,
        rowGap: desktop.rowGap,
        paddingTop: desktop.paddingTop,
        paddingBottom: desktop.paddingBottom,
        overflowTriggerHeight: desktop.defaultRowHeight,
        maxHeight: defaultMaxHeight,
      }),
    ).toEqual({
      visibleCount: 5,
      overflowCount: 2,
      fullContentHeight: 214,
      fittedHeight: 184,
    });
  });

  it("supports collapsing all the way down to 0 inline items (just the More row)", () => {
    expect(
      partitionSidebarNavItems({
        itemKeys: makeKeys(12),
        measuredHeights: {},
        defaultRowHeight: desktop.defaultRowHeight,
        rowGap: desktop.rowGap,
        paddingTop: desktop.paddingTop,
        paddingBottom: desktop.paddingBottom,
        overflowTriggerHeight: desktop.defaultRowHeight,
        maxHeight: 34,
      }),
    ).toEqual({
      visibleCount: 0,
      overflowCount: 12,
      fullContentHeight: 364,
      fittedHeight: 34,
    });
  });

  it("expands smoothly as dragged height grows until all items are visible", () => {
    const partitionAt = (maxHeight: number) =>
      partitionSidebarNavItems({
        itemKeys: makeKeys(12),
        measuredHeights: {},
        defaultRowHeight: desktop.defaultRowHeight,
        rowGap: desktop.rowGap,
        paddingTop: desktop.paddingTop,
        paddingBottom: desktop.paddingBottom,
        overflowTriggerHeight: desktop.defaultRowHeight,
        maxHeight,
      });

    expect(partitionAt(214)).toMatchObject({
      visibleCount: 6,
      overflowCount: 6,
      fittedHeight: 214,
    });
    expect(partitionAt(244)).toMatchObject({
      visibleCount: 7,
      overflowCount: 5,
      fittedHeight: 244,
    });
    expect(partitionAt(334)).toMatchObject({
      visibleCount: 10,
      overflowCount: 2,
      fittedHeight: 334,
    });
    // Just below full height keeps 10 + More(2); once reaching 364 all 12 show directly.
    expect(partitionAt(355)).toMatchObject({
      visibleCount: 10,
      overflowCount: 2,
      fittedHeight: 334,
    });
    expect(partitionAt(364)).toMatchObject({
      visibleCount: 12,
      overflowCount: 0,
      fittedHeight: 364,
    });
  });

  it("handles zero-height empty plugins and tall multi-row plugins without oscillation", () => {
    // Empty plugin takes 0px and does not consume a slot.
    expect(
      partitionSidebarNavItems({
        itemKeys: makeKeys(7),
        measuredHeights: { "item-2": 0 },
        defaultRowHeight: 28,
        rowGap: 2,
        paddingTop: 0,
        paddingBottom: 6,
        overflowTriggerHeight: 28,
        maxHeight: 184,
      }),
    ).toEqual({
      visibleCount: 7,
      overflowCount: 0,
      fullContentHeight: 184,
      fittedHeight: 184,
    });

    // Multi-row plugin measured at 88px (3 rows) pushes later items out cleanly and stays stable
    // once its measured height is cached.
    const measured = { "item-0": 28, "item-1": 28, "item-2": 88 };
    const first = partitionSidebarNavItems({
      itemKeys: makeKeys(5),
      measuredHeights: measured,
      defaultRowHeight: 28,
      rowGap: 2,
      paddingTop: 0,
      paddingBottom: 6,
      overflowTriggerHeight: 28,
      maxHeight: 184,
    });
    // item-0(28) + gap(2) + item-1(28) + gap(2) + item-2(88) + gap(2) + trigger(28) + pad(6) = 184
    // Full height: 28 + 28 + 88 + 28 + 28 + 4*2 + 6 = 214
    expect(first).toEqual({
      visibleCount: 3,
      overflowCount: 2,
      fullContentHeight: 214,
      fittedHeight: 184,
    });

    // If item-2 (88px) itself doesn't fit with trigger at maxHeight=150, it moves to overflow
    // and stays there because its cached height remains 88px.
    const tighter = partitionSidebarNavItems({
      itemKeys: makeKeys(5),
      measuredHeights: measured,
      defaultRowHeight: 28,
      rowGap: 2,
      paddingTop: 0,
      paddingBottom: 6,
      overflowTriggerHeight: 28,
      maxHeight: 150,
    });
    expect(tighter).toEqual({
      visibleCount: 2,
      overflowCount: 3,
      fullContentHeight: 214,
      fittedHeight: 94,
    });
  });

  it("adapts unit row height for CJK / slightly taller fonts while ignoring multi-row plugins", () => {
    expect(
      resolveUnitRowHeight({
        itemKeys: ["a", "b", "c"],
        measuredHeights: { a: 29.4, b: 88 },
        defaultRowHeight: 28,
      }),
    ).toBe(30);

    const compact = resolveSidebarNavMetrics({ compact: true, touchSized: true });
    expect(compact.defaultSlotCount).toBe(DEFAULT_SIDEBAR_NAV_MAX_ROWS_COMPACT);
    expect(
      resolveDefaultSidebarNavMaxHeight({
        unitRowHeight: compact.defaultRowHeight,
        slotCount: compact.defaultSlotCount,
        rowGap: compact.rowGap,
        paddingTop: compact.paddingTop,
        paddingBottom: compact.paddingBottom,
      }),
    ).toBe(242);

    // Wide touch tablet (e.g. iPad): touch-sized 44pt rows without mobile top padding.
    const tablet = resolveSidebarNavMetrics({ compact: false, touchSized: true });
    expect(tablet).toEqual({
      defaultRowHeight: 44,
      rowGap: 2,
      paddingTop: 0,
      paddingBottom: 6,
      defaultSlotCount: DEFAULT_SIDEBAR_NAV_MAX_ROWS_COMPACT,
    });
  });

  it("clamps bounds and preferred heights to half the viewport height", () => {
    const bounds = resolveSidebarNavBounds({
      viewportHeight: 480,
      fullContentHeight: 364,
      minHeight: 34,
    });
    expect(bounds).toEqual({
      minHeight: 34,
      viewportMaxHeight: 240,
      maxDragHeight: 240,
    });

    expect(
      resolveEffectiveSidebarNavMaxHeight({
        preferredMaxHeight: 364,
        defaultMaxHeight: 184,
        minHeight: bounds.minHeight,
        viewportMaxHeight: bounds.viewportMaxHeight,
      }),
    ).toBe(240);

    expect(
      resolveEffectiveSidebarNavMaxHeight({
        preferredMaxHeight: null,
        defaultMaxHeight: 184,
        minHeight: bounds.minHeight,
        viewportMaxHeight: bounds.viewportMaxHeight,
      }),
    ).toBe(184);
  });
});
