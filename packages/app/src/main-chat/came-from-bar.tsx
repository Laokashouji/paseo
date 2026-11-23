import { router, type Href } from "expo-router";
import { ArrowLeft, X } from "lucide-react-native";
import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { Theme } from "@/styles/theme";
import { matchesCameFromTarget, useMainChatCameFromStore } from "./came-from-store";

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedX = withUnistyles(X);

const accentIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface MainChatCameFromBarProps {
  serverId: string;
  workspaceId: string;
}

/**
 * Compact lossless return banner shown at the top of a target workspace screen when the user
 * jumped there full-page from Main Chat (or from a direction conversation).
 */
export const MainChatCameFromBar = memo(function MainChatCameFromBar({
  serverId,
  workspaceId,
}: MainChatCameFromBarProps) {
  const { t } = useTranslation();
  const entry = useMainChatCameFromStore((state) => state.entry);
  const clearCameFrom = useMainChatCameFromStore((state) => state.clearCameFrom);

  const visible = matchesCameFromTarget(entry, { serverId, workspaceId });

  const handleReturn = useCallback(() => {
    if (!entry) return;
    const destination = entry.originRoute;
    clearCameFrom();
    router.push(destination as Href);
  }, [clearCameFrom, entry]);

  const handleDismiss = useCallback(() => {
    clearCameFrom();
  }, [clearCameFrom]);

  if (!visible || !entry) {
    return null;
  }

  const originTitle = entry.originTitle || t("mainChat.shell.roleMain");
  const backLabel = t("mainChat.cameFrom.backTo", { title: originTitle });

  return (
    <View style={styles.bar} testID="main-chat-came-from-bar">
      <PressHighlight
        onPress={handleReturn}
        style={styles.returnButton}
        highlightStyle={styles.returnButtonPressed}
        accessibilityRole="button"
        accessibilityLabel={backLabel}
        testID="main-chat-came-from-return"
      >
        <ThemedArrowLeft size={14} uniProps={accentIconMapping} />
        <Text style={styles.returnText} numberOfLines={1}>
          {backLabel}
        </Text>
      </PressHighlight>
      <PressHighlight
        onPress={handleDismiss}
        style={styles.dismissButton}
        highlightStyle={styles.dismissButtonPressed}
        accessibilityRole="button"
        accessibilityLabel={t("mainChat.cameFrom.dismiss")}
        testID="main-chat-came-from-dismiss"
      >
        <ThemedX size={14} uniProps={mutedIconMapping} />
      </PressHighlight>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    minHeight: 34,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  returnButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexShrink: 1,
    minWidth: 0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.md,
  },
  returnButtonPressed: {
    backgroundColor: theme.colors.surface3,
  },
  returnText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.primary,
    flexShrink: 1,
  },
  dismissButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  dismissButtonPressed: {
    backgroundColor: theme.colors.surface3,
  },
}));
