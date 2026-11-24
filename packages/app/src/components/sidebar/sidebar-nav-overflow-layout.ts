/**
 * Pure geometry and overflow partitioning for the sidebar top navigation block.
 *
 * Keeping item splitting height-driven guarantees rows are never half-clipped:
 * items that fit cleanly stay inline, and every remaining item moves into the
 * secondary "More" menu in the user's configured order.
 */

export const DEFAULT_SIDEBAR_NAV_MAX_ROWS_WIDE = 6;
export const DEFAULT_SIDEBAR_NAV_MAX_ROWS_COMPACT = 5;

export const SIDEBAR_NAV_ROW_GAP = 2;
export const SIDEBAR_NAV_POINTER_ROW_HEIGHT = 28;
export const SIDEBAR_NAV_TOUCH_ROW_HEIGHT = 44;
export const SIDEBAR_NAV_PADDING_BOTTOM = 6;
export const SIDEBAR_NAV_MOBILE_PADDING_TOP = 8;

/** Safety cap preserving the existing "nav stays within half the sidebar" invariant. */
export const SIDEBAR_NAV_VIEWPORT_MAX_RATIO = 0.5;

/** Upper allowance above nominal row height when inferring single-row height for CJK / scaled fonts. */
const MAX_SINGLE_ROW_FONT_DELTA = 12;

export interface SidebarNavMetrics {
  defaultRowHeight: number;
  rowGap: number;
  paddingTop: number;
  paddingBottom: number;
  defaultSlotCount: number;
}

export function resolveSidebarNavMetrics(input: {
  compact: boolean;
  touchSized: boolean;
}): SidebarNavMetrics {
  return {
    defaultRowHeight: input.touchSized
      ? SIDEBAR_NAV_TOUCH_ROW_HEIGHT
      : SIDEBAR_NAV_POINTER_ROW_HEIGHT,
    rowGap: SIDEBAR_NAV_ROW_GAP,
    paddingTop: input.compact ? SIDEBAR_NAV_MOBILE_PADDING_TOP : 0,
    paddingBottom: SIDEBAR_NAV_PADDING_BOTTOM,
    defaultSlotCount: input.touchSized
      ? DEFAULT_SIDEBAR_NAV_MAX_ROWS_COMPACT
      : DEFAULT_SIDEBAR_NAV_MAX_ROWS_WIDE,
  };
}

/**
 * Infers the single-row height from measured items so CJK line-heights (e.g. 29–30px vs 28px)
 * do not accidentally shrink the default 6-slot budget by a whole row, while ignoring tall
 * multi-row plugin items.
 */
export function resolveUnitRowHeight(input: {
  itemKeys: readonly string[];
  measuredHeights: Readonly<Record<string, number>>;
  defaultRowHeight: number;
}): number {
  const maxSingleRow = input.defaultRowHeight + MAX_SINGLE_ROW_FONT_DELTA;
  let inferred = input.defaultRowHeight;
  for (const key of input.itemKeys) {
    const measured = input.measuredHeights[key];
    if (
      typeof measured === "number" &&
      Number.isFinite(measured) &&
      measured >= input.defaultRowHeight &&
      measured <= maxSingleRow
    ) {
      inferred = Math.max(inferred, Math.ceil(measured));
    }
  }
  return inferred;
}

export function computeSidebarNavStackHeight(input: {
  rowHeights: readonly number[];
  rowGap: number;
  paddingTop: number;
  paddingBottom: number;
}): number {
  const nonZeroHeights = input.rowHeights.filter((h) => Number.isFinite(h) && h > 0);
  if (nonZeroHeights.length === 0) return 0;
  let total = input.paddingTop + input.paddingBottom;
  for (const height of nonZeroHeights) {
    total += height;
  }
  total += (nonZeroHeights.length - 1) * input.rowGap;
  return total;
}

export function resolveDefaultSidebarNavMaxHeight(input: {
  unitRowHeight: number;
  slotCount: number;
  rowGap: number;
  paddingTop: number;
  paddingBottom: number;
}): number {
  const count = Math.max(1, input.slotCount);
  return (
    input.paddingTop +
    count * input.unitRowHeight +
    (count - 1) * input.rowGap +
    input.paddingBottom
  );
}

export function resolveSidebarNavBounds(input: {
  viewportHeight: number;
  fullContentHeight: number;
  minHeight: number;
}): {
  minHeight: number;
  viewportMaxHeight: number;
  maxDragHeight: number;
} {
  const viewportMaxHeight =
    input.viewportHeight > 0
      ? Math.max(input.minHeight, Math.floor(input.viewportHeight * SIDEBAR_NAV_VIEWPORT_MAX_RATIO))
      : Math.max(input.minHeight, input.fullContentHeight);
  const maxDragHeight = Math.max(
    input.minHeight,
    Math.min(viewportMaxHeight, Math.max(input.minHeight, input.fullContentHeight)),
  );
  return {
    minHeight: input.minHeight,
    viewportMaxHeight,
    maxDragHeight,
  };
}

export function resolveEffectiveSidebarNavMaxHeight(input: {
  preferredMaxHeight: number | null;
  defaultMaxHeight: number;
  minHeight: number;
  viewportMaxHeight: number;
}): number {
  const requested = input.preferredMaxHeight ?? input.defaultMaxHeight;
  return Math.max(input.minHeight, Math.min(input.viewportMaxHeight, requested));
}

export interface SidebarNavPartitionInput {
  itemKeys: readonly string[];
  measuredHeights: Readonly<Record<string, number>>;
  defaultRowHeight: number;
  rowGap: number;
  paddingTop: number;
  paddingBottom: number;
  overflowTriggerHeight: number;
  maxHeight: number;
}

export interface SidebarNavPartitionResult {
  visibleCount: number;
  overflowCount: number;
  fullContentHeight: number;
  fittedHeight: number;
}

export function partitionSidebarNavItems(
  input: SidebarNavPartitionInput,
): SidebarNavPartitionResult {
  const totalItems = input.itemKeys.length;
  if (totalItems === 0) {
    return {
      visibleCount: 0,
      overflowCount: 0,
      fullContentHeight: 0,
      fittedHeight: 0,
    };
  }

  const allHeights = input.itemKeys.map((key) => {
    const measured = input.measuredHeights[key];
    if (typeof measured === "number" && Number.isFinite(measured) && measured >= 0) {
      return Math.ceil(measured);
    }
    return input.defaultRowHeight;
  });

  const fullContentHeight = computeSidebarNavStackHeight({
    rowHeights: allHeights,
    rowGap: input.rowGap,
    paddingTop: input.paddingTop,
    paddingBottom: input.paddingBottom,
  });

  if (fullContentHeight <= input.maxHeight) {
    return {
      visibleCount: totalItems,
      overflowCount: 0,
      fullContentHeight,
      fittedHeight: fullContentHeight,
    };
  }

  const triggerHeight = Math.ceil(Math.max(1, input.overflowTriggerHeight));
  let visibleCount = 0;
  let fittedHeight = computeSidebarNavStackHeight({
    rowHeights: [triggerHeight],
    rowGap: input.rowGap,
    paddingTop: input.paddingTop,
    paddingBottom: input.paddingBottom,
  });

  const visibleHeights: number[] = [];
  for (let index = 0; index < totalItems; index += 1) {
    visibleHeights.push(allHeights[index]);
    const candidateHeight = computeSidebarNavStackHeight({
      rowHeights: [...visibleHeights, triggerHeight],
      rowGap: input.rowGap,
      paddingTop: input.paddingTop,
      paddingBottom: input.paddingBottom,
    });
    if (candidateHeight <= input.maxHeight) {
      visibleCount = index + 1;
      fittedHeight = candidateHeight;
    } else {
      break;
    }
  }

  return {
    visibleCount,
    overflowCount: totalItems - visibleCount,
    fullContentHeight,
    fittedHeight,
  };
}
