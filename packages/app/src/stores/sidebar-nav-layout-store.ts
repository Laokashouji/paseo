import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const SIDEBAR_NAV_LAYOUT_STORAGE_KEY = "sidebar-nav-layout";
const SIDEBAR_NAV_LAYOUT_STORE_VERSION = 1;

export const MIN_PERSISTED_SIDEBAR_NAV_HEIGHT = 28;
export const MAX_PERSISTED_SIDEBAR_NAV_HEIGHT = 1200;

interface SidebarNavLayoutStoreState {
  /** User-dragged max height in px, or `null` to follow the default row cap. */
  maxHeight: number | null;
  setMaxHeight: (maxHeight: number | null) => void;
  resetMaxHeight: () => void;
}

interface SidebarNavLayoutPersistedState {
  maxHeight: number | null;
}

const SidebarNavLayoutPersistedStateSchema = z.strictObject({
  maxHeight: z.number().nullable().optional(),
});

export function normalizePersistedSidebarNavMaxHeight(
  value: number | null | undefined,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const rounded = Math.ceil(value);
  return Math.max(
    MIN_PERSISTED_SIDEBAR_NAV_HEIGHT,
    Math.min(MAX_PERSISTED_SIDEBAR_NAV_HEIGHT, rounded),
  );
}

export function migrateSidebarNavLayoutState(
  persistedState: unknown,
): SidebarNavLayoutPersistedState {
  const result = SidebarNavLayoutPersistedStateSchema.safeParse(persistedState);
  if (!result.success) {
    return { maxHeight: null };
  }
  return {
    maxHeight: normalizePersistedSidebarNavMaxHeight(result.data.maxHeight),
  };
}

export const useSidebarNavLayoutStore = create<SidebarNavLayoutStoreState>()(
  persist(
    (set) => ({
      maxHeight: null,
      setMaxHeight: (maxHeight) =>
        set({ maxHeight: normalizePersistedSidebarNavMaxHeight(maxHeight) }),
      resetMaxHeight: () => set({ maxHeight: null }),
    }),
    {
      name: SIDEBAR_NAV_LAYOUT_STORAGE_KEY,
      version: SIDEBAR_NAV_LAYOUT_STORE_VERSION,
      storage: createValidatedPersistStorage(AsyncStorage, SidebarNavLayoutPersistedStateSchema),
      partialize: (state) => ({
        maxHeight: state.maxHeight,
      }),
      migrate: migrateSidebarNavLayoutState,
    },
  ),
);
