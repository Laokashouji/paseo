import * as Linking from "expo-linking";
import { router } from "expo-router";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import {
  getActivePersonaHub,
  normalizePersonaHubUrl,
  selectActivePersonaHub,
  type PersonaHubProfile,
} from "./settings";
import {
  usePersonaEmbedSettingsState,
  useUpdatePersonaEmbedSettings,
} from "./use-persona-settings";

const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const NativeHubOptionButton = memo(function NativeHubOptionButton({
  hub,
  isSelected,
  onSelect,
}: {
  hub: PersonaHubProfile;
  isSelected: boolean;
  onSelect: (hubId: string) => void;
}) {
  const handlePress = useCallback(() => {
    onSelect(hub.id);
  }, [hub.id, onSelect]);
  return (
    <Button
      size="sm"
      variant={isSelected ? "default" : "outline"}
      onPress={handlePress}
      testID={`persona-native-hub-option-${hub.id}`}
    >
      {hub.name}
    </Button>
  );
});

export function PersonaSurface() {
  const { t } = useTranslation();
  const { settings: personaSettings, isLoaded } = usePersonaEmbedSettingsState();
  const updatePersonaSettings = useUpdatePersonaEmbedSettings();

  const activeHub = useMemo(() => getActivePersonaHub(personaSettings), [personaSettings]);
  const normalizedHub = useMemo(
    () => normalizePersonaHubUrl(activeHub?.hubUrl ?? ""),
    [activeHub?.hubUrl],
  );
  const validHubUrl = normalizedHub.ok ? normalizedHub.url : null;

  const handleSelectHub = useCallback(
    (hubId: string) => {
      void updatePersonaSettings((current) => selectActivePersonaHub(current, hubId));
    },
    [updatePersonaSettings],
  );

  const handleOpenExternal = useCallback(() => {
    if (!validHubUrl) {
      return;
    }
    void Linking.openURL(validHubUrl).catch(() => undefined);
  }, [validHubUrl]);

  const handleOpenSettings = useCallback(() => {
    router.push(buildSettingsSectionRoute("persona"));
  }, []);

  if (!isLoaded) {
    return (
      <View style={styles.container} testID="persona-surface-native-loading">
        <ThemedSpinner size="small" uniProps={mutedIcon} />
      </View>
    );
  }

  if (!personaSettings.enabled) {
    return (
      <View style={styles.container} testID="persona-surface-native-disabled">
        <View style={styles.card}>
          <Text style={styles.title}>{t("personaEmbed.error.disabledTitle")}</Text>
          <Text style={styles.description}>{t("personaEmbed.error.disabledDescription")}</Text>
          <View style={styles.actions}>
            <Button onPress={handleOpenSettings}>{t("personaEmbed.error.enableInSettings")}</Button>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="persona-surface-native">
      <View style={styles.card}>
        <Text style={styles.title}>{t("personaEmbed.webFallback.title")}</Text>
        <Text style={styles.description}>{t("personaEmbed.webFallback.description")}</Text>

        {personaSettings.hubs.length > 1 ? (
          <View style={styles.hubSwitcherSection} testID="persona-native-hub-switcher">
            <Text style={styles.hubSwitcherLabel}>
              {t("personaEmbed.webFallback.hubSelectorLabel")}
            </Text>
            <View style={styles.hubSwitcherRow}>
              {personaSettings.hubs.map((hub) => (
                <NativeHubOptionButton
                  key={hub.id}
                  hub={hub}
                  isSelected={hub.id === activeHub?.id}
                  onSelect={handleSelectHub}
                />
              ))}
            </View>
          </View>
        ) : null}

        <View style={styles.urlBox}>
          {activeHub ? (
            <Text numberOfLines={1} ellipsizeMode="tail" style={styles.hubNameText}>
              {activeHub.name}
            </Text>
          ) : null}
          <Text numberOfLines={1} ellipsizeMode="middle" style={styles.urlText}>
            {validHubUrl ?? t("personaEmbed.error.invalidUrl")}
          </Text>
        </View>
        <View style={styles.actions}>
          <Button onPress={handleOpenExternal} disabled={!validHubUrl}>
            {t("personaEmbed.toolbar.openExternal")}
          </Button>
          <Button variant="outline" onPress={handleOpenSettings}>
            {t("personaEmbed.webFallback.openSettings")}
          </Button>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    padding: theme.spacing[6],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
  },
  card: {
    width: "100%",
    maxWidth: 480,
    padding: theme.spacing[6],
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[3],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  hubSwitcherSection: {
    gap: theme.spacing[2],
  },
  hubSwitcherLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  hubSwitcherRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  urlBox: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 2,
  },
  hubNameText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.code,
    fontWeight: theme.fontWeight.medium,
  },
  urlText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
}));
