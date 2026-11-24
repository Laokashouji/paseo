import { useCallback, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { ScrollView, type LayoutChangeEvent } from "react-native";
import { type GestureType, ScrollView as GHScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { WINDOW_CONTENT_DATASET } from "@/components/desktop/titlebar-drag-region";
import { SidebarNavResizeHandle } from "@/components/sidebar/sidebar-nav-resize-handle";
import { useVisibleSidebarNavItems } from "@/components/sidebar/sidebar-nav-rows";
import {
  SidebarNavSectionContext,
  type SidebarNavLayoutSnapshot,
  type SidebarNavSectionContextValue,
} from "@/components/sidebar/sidebar-nav-section-context";
import { isNative as platformIsNative } from "@/constants/platform";
import { useSidebarNavLayoutStore } from "@/stores/sidebar-nav-layout-store";

export interface SidebarNavScrollProps {
  closeGestureRef?: RefObject<GestureType | undefined>;
  /** Web only: the viewport emits no window regions (see WINDOW_CONTENT_DATASET). */
  windowContent?: boolean;
  children: ReactNode;
}

/**
 * The capped, resizable nav block shared by the mobile and desktop sidebars,
 * with the draggable divider below it. The divider is a sibling because
 * Unistyles does not patch the gesture-handler ScrollView.
 */
export function SidebarNavScroll({
  closeGestureRef,
  windowContent,
  children,
}: SidebarNavScrollProps) {
  const visibleNavCount = useVisibleSidebarNavItems().length;
  const setMaxHeight = useSidebarNavLayoutStore((state) => state.setMaxHeight);
  const resetMaxHeight = useSidebarNavLayoutStore((state) => state.resetMaxHeight);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const containerHeightRef = useRef<number>(0);
  const dragStartHeightRef = useRef<number>(0);
  const snapshotRef = useRef<SidebarNavLayoutSnapshot | null>(null);

  const handleContainerLayout = useCallback((event: LayoutChangeEvent) => {
    containerHeightRef.current = Math.ceil(event.nativeEvent.layout.height);
  }, []);

  const handleDragStart = useCallback(() => {
    const snapshot = snapshotRef.current;
    snapshot?.onDragStart?.();
    const initial =
      containerHeightRef.current > 0 ? containerHeightRef.current : (snapshot?.fittedHeight ?? 0);
    dragStartHeightRef.current = initial;
    if (initial > 0) {
      setDragHeight(initial);
    }
  }, []);

  const handleDragDelta = useCallback((deltaY: number) => {
    const snapshot = snapshotRef.current;
    if (!snapshot) return;
    const clamped = Math.max(
      snapshot.minHeight,
      Math.min(snapshot.maxDragHeight, dragStartHeightRef.current + deltaY),
    );
    setDragHeight(clamped);
  }, []);

  const handleDragEnd = useCallback(
    (deltaY: number) => {
      const snapshot = snapshotRef.current;
      if (snapshot) {
        const clamped = Math.max(
          snapshot.minHeight,
          Math.min(snapshot.maxDragHeight, dragStartHeightRef.current + deltaY),
        );
        setMaxHeight(snapshot.resolveCommitHeight(clamped));
      }
      setDragHeight(null);
    },
    [setMaxHeight],
  );

  const handleDragCancel = useCallback(() => {
    setDragHeight(null);
  }, []);

  const sectionContextValue = useMemo<SidebarNavSectionContextValue>(
    () => ({ dragHeight, snapshotRef }),
    [dragHeight],
  );

  const scrollStyle = useMemo(
    () =>
      dragHeight !== null
        ? [styles.navScroll, { height: dragHeight, maxHeight: dragHeight, flexShrink: 0 }]
        : styles.navScroll,
    [dragHeight],
  );

  return (
    <SidebarNavSectionContext.Provider value={sectionContextValue}>
      {platformIsNative ? (
        <GHScrollView
          // Same contract as the workspace list: vertical drags scroll the nav
          // block, a clear horizontal intent still activates the close pan.
          simultaneousHandlers={closeGestureRef}
          onLayout={handleContainerLayout}
          style={scrollStyle}
          showsVerticalScrollIndicator={false}
          alwaysBounceVertical={false}
          testID="sidebar-nav-scroll"
        >
          {children}
        </GHScrollView>
      ) : (
        <ScrollView
          dataSet={windowContent ? WINDOW_CONTENT_DATASET : undefined}
          onLayout={handleContainerLayout}
          style={scrollStyle}
          showsVerticalScrollIndicator={false}
          alwaysBounceVertical={false}
          testID="sidebar-nav-scroll"
        >
          {children}
        </ScrollView>
      )}
      <SidebarNavResizeHandle
        resizable={visibleNavCount > 1}
        onDragStart={handleDragStart}
        onDragDelta={handleDragDelta}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        onResetHeight={resetMaxHeight}
      />
    </SidebarNavSectionContext.Provider>
  );
}

const styles = StyleSheet.create({
  // The nav block caps at half the sidebar; items beyond the configured height move
  // into the secondary overflow menu, while this cap stays as an outer safety bound.
  navScroll: {
    flexGrow: 0,
    flexShrink: 1,
    maxHeight: "50%",
  },
});
