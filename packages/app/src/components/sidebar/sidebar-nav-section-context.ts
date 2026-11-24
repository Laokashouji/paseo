import { createContext, useContext, type RefObject } from "react";

export interface SidebarNavLayoutSnapshot {
  minHeight: number;
  maxDragHeight: number;
  fittedHeight: number;
  /** Returns the height to persist once a drag ends at `clampedHeight`. */
  resolveCommitHeight: (clampedHeight: number) => number;
  /** Called right before dragging begins so open overflow menus close cleanly. */
  onDragStart?: () => void;
}

export interface SidebarNavSectionContextValue {
  /** Live height during an active drag, or `null` at rest. */
  dragHeight: number | null;
  /** Latest layout snapshot written by `SidebarNavRows` for the resize handle. */
  snapshotRef: RefObject<SidebarNavLayoutSnapshot | null>;
}

export const SidebarNavSectionContext = createContext<SidebarNavSectionContextValue | null>(null);

export function useSidebarNavSectionContext(): SidebarNavSectionContextValue | null {
  return useContext(SidebarNavSectionContext);
}
