import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { Copy, ExternalLink, Settings } from "lucide-react-native";
import { useCallback, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import type { Theme } from "@/styles/theme";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { isMixedContentIframeBlocked, normalizePersonaHubUrl } from "./settings";
import { usePersonaEmbedSettingsState } from "./use-persona-settings";

const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedCopy = withUnistyles(Copy);
const ThemedSettings = withUnistyles(Settings);
const ThemedSpinner = withUnistyles(LoadingSpinner);

const accentForegroundIcon = (theme: Theme) => ({ color: theme.colors.accentForeground });
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// Opaque origin sandbox (no `allow-same-origin`) keeps the read-only Web preview isolated.
const PERSONA_WEB_IFRAME_SANDBOX = "allow-scripts allow-forms allow-popups";
const iframeStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  border: "0",
};

export interface PersonaWebFallbackProps {
  /** Test hook for simulating HTTPS mixed-content blocking in unit/browser tests. */
  pageProtocolOverride?: string;
}

export function PersonaSurface({ pageProtocolOverride }: PersonaWebFallbackProps = {}) {
  const { t } = useTranslation();
  const toast = useToast();
  const { settings: personaSettings, isLoaded } = usePersonaEmbedSettingsState();
  const [iframePreviewEnabled, setIframePreviewEnabled] = useState(false);

  const normalizedHub = useMemo(
    () => normalizePersonaHubUrl(personaSettings.hubUrl),
    [personaSettings.hubUrl],
  );
  const validHubUrl = normalizedHub.ok ? normalizedHub.url : null;

  const pageProtocol =
    pageProtocolOverride ?? (typeof window !== "undefined" ? window.location.protocol : undefined);
  const mixedContentBlocked =
    validHubUrl !== null && isMixedContentIframeBlocked(pageProtocol, validHubUrl);

  const handleOpenInNewTab = useCallback(() => {
    if (!validHubUrl || typeof window === "undefined") {
      return;
    }
    window.open(validHubUrl, "_blank", "noopener,noreferrer");
  }, [validHubUrl]);

  const handleCopyUrl = useCallback(() => {
    if (!validHubUrl) {
      return;
    }
    void (async () => {
      await Clipboard.setStringAsync(validHubUrl);
      toast.show(t("personaEmbed.webFallback.copiedUrl"), { variant: "success" });
    })();
  }, [t, toast, validHubUrl]);

  const handleOpenSettings = useCallback(() => {
    router.push(buildSettingsSectionRoute("persona"));
  }, []);

  if (!isLoaded) {
    return (
      <View style={styles.container} testID="persona-surface-web-loading">
        <ThemedSpinner size="small" uniProps={mutedIcon} />
      </View>
    );
  }

  if (!personaSettings.enabled) {
    return (
      <View style={styles.container} testID="persona-surface-web-disabled">
        <View style={styles.card}>
          <Text style={styles.title}>{t("personaEmbed.error.disabledTitle")}</Text>
          <Text style={styles.description}>{t("personaEmbed.error.disabledDescription")}</Text>
          <View style={styles.actions}>
            <Button onPress={handleOpenSettings} testID="persona-web-open-settings">
              {t("personaEmbed.error.enableInSettings")}
            </Button>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="persona-surface-web">
      <View style={styles.card}>
        <Text style={styles.title}>{t("personaEmbed.webFallback.title")}</Text>
        <Text style={styles.description}>{t("personaEmbed.webFallback.description")}</Text>

        <View style={styles.urlBox}>
          <Text numberOfLines={1} ellipsizeMode="middle" style={styles.urlText}>
            {validHubUrl ?? t("personaEmbed.error.invalidUrl")}
          </Text>
        </View>

        <View style={styles.actions}>
          <Button
            onPress={handleOpenInNewTab}
            disabled={!validHubUrl}
            testID="persona-web-open-tab"
          >
            <ThemedExternalLink size={14} uniProps={accentForegroundIcon} />
            <Text style={styles.primaryButtonText}>{t("personaEmbed.webFallback.openTab")}</Text>
          </Button>
          <Button
            variant="outline"
            onPress={handleCopyUrl}
            disabled={!validHubUrl}
            testID="persona-web-copy-url"
          >
            <ThemedCopy size={14} uniProps={mutedIcon} />
            <Text style={styles.secondaryButtonText}>{t("personaEmbed.webFallback.copyUrl")}</Text>
          </Button>
          <Button variant="ghost" onPress={handleOpenSettings} testID="persona-web-open-settings">
            <ThemedSettings size={14} uniProps={mutedIcon} />
            <Text style={styles.secondaryButtonText}>
              {t("personaEmbed.webFallback.openSettings")}
            </Text>
          </Button>
        </View>

        {validHubUrl ? (
          <View style={styles.iframeToggleSection}>
            <View style={styles.iframeToggleRow}>
              <Text style={styles.iframeToggleLabel}>
                {t("personaEmbed.webFallback.iframeToggle")}
              </Text>
              <Switch
                value={iframePreviewEnabled}
                onValueChange={setIframePreviewEnabled}
                accessibilityLabel={t("personaEmbed.webFallback.iframeToggle")}
                testID="persona-web-iframe-toggle"
              />
            </View>
            {iframePreviewEnabled && mixedContentBlocked ? (
              <View style={styles.warningBox} testID="persona-web-mixed-content-warning">
                <Text style={styles.warningText}>
                  {t("personaEmbed.webFallback.mixedContentBlocked", { url: validHubUrl })}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>

      {validHubUrl && iframePreviewEnabled && !mixedContentBlocked ? (
        <View style={styles.iframeContainer} testID="persona-web-iframe-container">
          <iframe
            src={validHubUrl}
            title={t("personaEmbed.sidebar.title")}
            sandbox={PERSONA_WEB_IFRAME_SANDBOX}
            referrerPolicy="no-referrer"
            style={iframeStyle}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    padding: theme.spacing[6],
    gap: theme.spacing[4],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
  },
  card: {
    width: "100%",
    maxWidth: 560,
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
  urlBox: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
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
  primaryButtonText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  secondaryButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  iframeToggleSection: {
    marginTop: theme.spacing[2],
    paddingTop: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  iframeToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  iframeToggleLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flex: 1,
  },
  warningBox: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.statusWarning,
  },
  warningText: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.code,
    lineHeight: 18,
  },
  iframeContainer: {
    flex: 1,
    width: "100%",
    minHeight: 420,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
}));
