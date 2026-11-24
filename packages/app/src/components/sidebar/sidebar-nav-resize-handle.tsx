import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { View, type PointerEvent as RNPointerEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
import {
  SIDEBAR_RESIZE_ACTIVATION_OFFSET,
  SIDEBAR_RESIZE_FAIL_OFFSET,
} from "@/components/sidebar-resize-handle-layout";
import { isWeb } from "@/constants/platform";
import { usePointerCapabilities } from "@/hooks/pointer-capabilities";

const HIGHLIGHT_DELAY_MS = 100;
const DRAG_MOVE_THRESHOLD_PX = 2;
const DOUBLE_CLICK_WINDOW_MS = 320;

const webHitAreaStyle = isWeb
  ? ({
      cursor: "row-resize",
      touchAction: "none",
    } as object)
  : null;

const touchActionNoneStyle = isWeb ? ({ touchAction: "none" } as object) : null;

export interface SidebarNavResizeHandleProps {
  /** When false (0 or 1 item), renders the plain separator without a drag affordance. */
  resizable: boolean;
  onDragStart: () => void;
  onDragDelta: (deltaY: number) => void;
  onDragEnd: (deltaY: number) => void;
  onDragCancel: () => void;
  onResetHeight: () => void;
}

/**
 * Full-width separator beneath the sidebar navigation section that doubles as a
 * vertical resize handle. At rest it looks identical to `SidebarSeparator`; hovering
 * or dragging reveals a subtle accent indicator, and double-clicking resets to default.
 */
export function SidebarNavResizeHandle({
  resizable,
  onDragStart,
  onDragDelta,
  onDragEnd,
  onDragCancel,
  onResetHeight,
}: SidebarNavResizeHandleProps) {
  const { t } = useTranslation();
  const { finePointer } = usePointerCapabilities();
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeCleanupRef = useRef<(() => void) | null>(null);
  const lastTapTimestampRef = useRef<number>(0);
  const touchStartYRef = useRef<number | null>(null);
  const touchLastDeltaRef = useRef<number>(0);
  const touchStartedRef = useRef<boolean>(false);

  // Keep latest callbacks in refs so long pointer drags never capture stale closures.
  const callbacksRef = useRef({
    onDragStart,
    onDragDelta,
    onDragEnd,
    onDragCancel,
    onResetHeight,
  });
  callbacksRef.current = {
    onDragStart,
    onDragDelta,
    onDragEnd,
    onDragCancel,
    onResetHeight,
  };

  const cancelHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      cancelHoverTimer();
      activeCleanupRef.current?.();
      activeCleanupRef.current = null;
    },
    [cancelHoverTimer],
  );

  const handlePointerEnter = useCallback(() => {
    cancelHoverTimer();
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      setHovered(true);
    }, HIGHLIGHT_DELAY_MS);
  }, [cancelHoverTimer]);

  const handlePointerLeave = useCallback(() => {
    cancelHoverTimer();
    setHovered(false);
  }, [cancelHoverTimer]);

  const handlePointerDown = useCallback((event: RNPointerEvent) => {
    if (!isWeb || typeof window === "undefined" || typeof document === "undefined") {
      return;
    }
    if (event.nativeEvent.button !== undefined && event.nativeEvent.button !== 0) {
      return;
    }

    const hitAreaElement = event.currentTarget as unknown as HTMLElement | null;
    const pointerId = event.nativeEvent.pointerId;
    const startY = event.nativeEvent.clientY;
    let moved = false;

    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    event.preventDefault();
    event.stopPropagation();
    try {
      hitAreaElement?.setPointerCapture?.(pointerId);
    } catch {
      // Synthetic or cancelled pointers may not be active; window listeners still track the drag.
    }

    function cleanup() {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      try {
        if (hitAreaElement?.hasPointerCapture?.(pointerId)) {
          hitAreaElement.releasePointerCapture(pointerId);
        }
      } catch {
        // Ignore capture release errors after unmount or pointer loss.
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      activeCleanupRef.current = null;
      setDragging(false);
    }

    function handlePointerMove(moveEvent: PointerEvent) {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const deltaY = moveEvent.clientY - startY;
      if (!moved && Math.abs(deltaY) >= DRAG_MOVE_THRESHOLD_PX) {
        moved = true;
        setDragging(true);
        callbacksRef.current.onDragStart();
      }
      if (moved) {
        callbacksRef.current.onDragDelta(deltaY);
      }
    }

    function handlePointerUp(upEvent: PointerEvent) {
      if (upEvent.pointerId !== pointerId) return;
      const finalDeltaY = upEvent.clientY - startY;
      cleanup();
      if (moved) {
        lastTapTimestampRef.current = 0;
        callbacksRef.current.onDragEnd(finalDeltaY);
        return;
      }
      const now = Date.now();
      if (now - lastTapTimestampRef.current <= DOUBLE_CLICK_WINDOW_MS) {
        lastTapTimestampRef.current = 0;
        callbacksRef.current.onResetHeight();
      } else {
        lastTapTimestampRef.current = now;
      }
    }

    function handlePointerCancel(cancelEvent: PointerEvent) {
      if (cancelEvent.pointerId !== pointerId) return;
      cleanup();
      if (moved) {
        callbacksRef.current.onDragCancel();
      }
    }

    activeCleanupRef.current?.();
    activeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
  }, []);

  const touchGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(resizable && !finePointer)
        .runOnJS(true)
        .activeOffsetY([-SIDEBAR_RESIZE_ACTIVATION_OFFSET, SIDEBAR_RESIZE_ACTIVATION_OFFSET])
        .failOffsetX([-SIDEBAR_RESIZE_FAIL_OFFSET, SIDEBAR_RESIZE_FAIL_OFFSET])
        .onBegin((event) => {
          touchStartYRef.current = event.absoluteY;
          touchLastDeltaRef.current = 0;
          touchStartedRef.current = false;
        })
        .onStart(() => {
          touchStartedRef.current = true;
          setDragging(true);
          callbacksRef.current.onDragStart();
        })
        .onUpdate((event) => {
          if (touchStartYRef.current === null) return;
          const deltaY = event.absoluteY - touchStartYRef.current;
          touchLastDeltaRef.current = deltaY;
          callbacksRef.current.onDragDelta(deltaY);
        })
        .onEnd((_event, success) => {
          if (!touchStartedRef.current) return;
          if (success) {
            callbacksRef.current.onDragEnd(touchLastDeltaRef.current);
          } else {
            callbacksRef.current.onDragCancel();
          }
        })
        .onFinalize(() => {
          touchStartYRef.current = null;
          touchLastDeltaRef.current = 0;
          touchStartedRef.current = false;
          setDragging(false);
        }),
    [finePointer, resizable],
  );

  const highlighted = hovered || dragging;
  const label = t("sidebar.nav.resizeHandle");

  if (!resizable) {
    return <SidebarSeparator testID="sidebar-nav-separator" />;
  }

  return (
    <View style={styles.container}>
      <SidebarSeparator testID="sidebar-nav-separator" />
      {highlighted ? (
        <View
          pointerEvents="none"
          testID="sidebar-nav-resize-handle-highlight"
          style={[styles.highlight, dragging ? styles.highlightDragging : styles.highlightHover]}
        >
          <View style={styles.pill} />
        </View>
      ) : null}
      {finePointer && isWeb ? (
        <View
          role="separator"
          aria-orientation="horizontal"
          accessibilityLabel={label}
          testID="sidebar-nav-resize-handle"
          style={[styles.pointerHitArea, webHitAreaStyle]}
          onPointerDown={handlePointerDown}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
        />
      ) : (
        <GestureDetector gesture={touchGesture}>
          <View
            role="separator"
            aria-orientation="horizontal"
            accessibilityLabel={label}
            collapsable={false}
            testID="sidebar-nav-resize-handle"
            style={[styles.touchHitArea, touchActionNoneStyle]}
          >
            <View
              pointerEvents="none"
              style={[
                styles.touchGrip,
                dragging ? styles.touchGripVisible : styles.touchGripHidden,
              ]}
            />
          </View>
        </GestureDetector>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "relative",
    zIndex: 10,
  },
  highlight: {
    position: "absolute",
    left: 0,
    right: 0,
    top: -1,
    height: 2,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 5,
  },
  highlightHover: {
    opacity: 0.65,
  },
  highlightDragging: {
    opacity: 1,
  },
  pill: {
    width: 28,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: theme.colors.accent,
  },
  pointerHitArea: {
    position: "absolute",
    left: 0,
    right: 0,
    top: -5,
    height: 10,
    zIndex: 10,
  },
  touchHitArea: {
    position: "absolute",
    left: "50%",
    top: -12,
    width: 88,
    height: 24,
    transform: [{ translateX: -44 }],
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  touchGrip: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.foreground,
  },
  touchGripHidden: {
    opacity: 0.14,
  },
  touchGripVisible: {
    opacity: 0.35,
  },
}));
