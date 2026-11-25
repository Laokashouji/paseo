import { useCallback, useState, type PropsWithChildren } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ResizeHandle } from "@/components/resize-handle";
import { usePanelStore } from "@/stores/panel-store";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

export function TaskDrawerFrame({
  containerWidth,
  children,
}: PropsWithChildren<{ containerWidth: number }>) {
  const { t } = useTranslation();
  const saved = usePanelStore((state) => state.taskDrawerWidth);
  const save = usePanelStore((state) => state.setTaskDrawerWidth);
  const [preview, setPreview] = useState<number | null>(null);
  const clamp = useCallback(
    (value: number) => {
      const chatMin = Math.min(360, containerWidth / 2);
      const max = Math.max(0, containerWidth - chatMin);
      return Math.min(max, Math.max(Math.min(340, max), Math.round(value)));
    },
    [containerWidth],
  );
  const width = clamp(preview ?? saved ?? Math.min(640, containerWidth * 0.42));
  const onPreview = useCallback(
    (_: string, sizes: number[]) => setPreview(clamp(sizes[1] * containerWidth)),
    [containerWidth, clamp],
  );
  const onCommit = useCallback(
    (_: string, sizes: number[]) => {
      save(clamp(sizes[1] * containerWidth));
      setPreview(null);
    },
    [containerWidth, clamp, save],
  );
  const ratio = containerWidth > 0 ? width / containerWidth : 0;
  return (
    <View
      testID="main-chat-task-drawer-frame"
      style={[styles.frame, inlineUnistylesStyle({ width })]}
    >
      {children}
      <View style={styles.handle}>
        <ResizeHandle
          testID="main-chat-task-drawer-resize"
          accessibilityLabel={t("mainChat.taskDrawerResize")}
          direction="horizontal"
          hitAreaAlignment="end"
          groupId="main-chat-task-drawer"
          index={0}
          sizes={[1 - ratio, ratio]}
          containerSize={containerWidth}
          onPreviewResizeSplit={onPreview}
          onResizeSplit={onCommit}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { position: "relative", flexShrink: 0, minHeight: 0 },
  handle: { position: "absolute", top: 0, bottom: 0, left: 0, zIndex: 2, flexDirection: "row" },
});
