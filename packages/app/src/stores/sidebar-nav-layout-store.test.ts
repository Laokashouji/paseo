import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PERSISTED_SIDEBAR_NAV_HEIGHT,
  MIN_PERSISTED_SIDEBAR_NAV_HEIGHT,
  migrateSidebarNavLayoutState,
  normalizePersistedSidebarNavMaxHeight,
  useSidebarNavLayoutStore,
} from "./sidebar-nav-layout-store";

describe("sidebar nav layout store", () => {
  beforeEach(() => {
    useSidebarNavLayoutStore.setState({ maxHeight: null });
  });

  it("defaults to null and stores clamped integer heights", () => {
    expect(useSidebarNavLayoutStore.getState().maxHeight).toBeNull();

    useSidebarNavLayoutStore.getState().setMaxHeight(214.2);
    expect(useSidebarNavLayoutStore.getState().maxHeight).toBe(215);

    useSidebarNavLayoutStore.getState().setMaxHeight(10);
    expect(useSidebarNavLayoutStore.getState().maxHeight).toBe(MIN_PERSISTED_SIDEBAR_NAV_HEIGHT);

    useSidebarNavLayoutStore.getState().setMaxHeight(5000);
    expect(useSidebarNavLayoutStore.getState().maxHeight).toBe(MAX_PERSISTED_SIDEBAR_NAV_HEIGHT);

    useSidebarNavLayoutStore.getState().resetMaxHeight();
    expect(useSidebarNavLayoutStore.getState().maxHeight).toBeNull();
  });

  it("normalizes invalid persisted values to null", () => {
    expect(normalizePersistedSidebarNavMaxHeight(undefined)).toBeNull();
    expect(normalizePersistedSidebarNavMaxHeight(null)).toBeNull();
    expect(normalizePersistedSidebarNavMaxHeight(0)).toBeNull();
    expect(normalizePersistedSidebarNavMaxHeight(-40)).toBeNull();
    expect(normalizePersistedSidebarNavMaxHeight(Number.NaN)).toBeNull();
    expect(normalizePersistedSidebarNavMaxHeight(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("migrates valid and invalid payloads safely", () => {
    expect(migrateSidebarNavLayoutState({ maxHeight: 184 })).toEqual({ maxHeight: 184 });
    expect(migrateSidebarNavLayoutState({ maxHeight: null })).toEqual({ maxHeight: null });
    expect(migrateSidebarNavLayoutState({ maxHeight: "bad" })).toEqual({ maxHeight: null });
    expect(migrateSidebarNavLayoutState({ unexpected: true })).toEqual({ maxHeight: null });
    expect(migrateSidebarNavLayoutState(null)).toEqual({ maxHeight: null });
  });
});
