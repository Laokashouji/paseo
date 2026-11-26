import { router } from "expo-router";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PersonaSurface } from "@/persona/persona-surface";
import { disableResidentPersonaWebview } from "@/persona/resident-persona-webview";
import { usePersonaEmbedSettingsState } from "@/persona/use-persona-settings";
import type { Theme } from "@/styles/theme";
import { buildSettingsSectionRoute } from "@/utils/host-routes";

const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function PersonaRouteGate() {
  const { t } = useTranslation();
  const { settings, isLoaded } = usePersonaEmbedSettingsState();

  useEffect(() => {
    if (isLoaded && !settings.enabled) {
      void disableResidentPersonaWebview();
    }
  }, [isLoaded, settings.enabled]);

  const handleOpenSettings = useCallback(() => {
    router.push(buildSettingsSectionRoute("persona"));
  }, []);

  if (!isLoaded) {
    return (
      <View style={styles.centerContainer} testID="persona-route-loading">
        <ThemedSpinner size="small" uniProps={mutedIconMapping} />
      </View>
    );
  }

  if (!settings.enabled) {
    return (
      <View style={styles.centerContainer} testID="persona-route-disabled">
        <View style={styles.card}>
          <Text style={styles.title}>{t("personaEmbed.error.disabledTitle")}</Text>
          <Text style={styles.description}>{t("personaEmbed.error.disabledDescription")}</Text>
          <View style={styles.actions}>
            <Button onPress={handleOpenSettings} testID="persona-route-open-settings">
              {t("personaEmbed.error.enableInSettings")}
            </Button>
          </View>
        </View>
      </View>
    );
  }

  return <PersonaSurface />;
}

export default function PersonaRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <PersonaRouteGate />
    </HostRouteBootstrapBoundary>
  );
}

const styles = StyleSheet.create((theme) => ({
  centerContainer: {
    flex: 1,
    padding: theme.spacing[6],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
  },
  card: {
    width: "100%",
    maxWidth: 460,
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
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
}));
