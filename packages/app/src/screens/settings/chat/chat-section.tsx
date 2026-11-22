import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { SettingsTextArea } from "@/components/settings-textarea";
import { Button } from "@/components/ui/button";
import { isNative } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useAppSettings, type ChatDisplay } from "@/hooks/use-settings";
import { DEFAULT_ARCHIVE_COMMAND } from "@/session-archive/constants";
import { settingsStyles } from "@/styles/settings";

const CHAT_DISPLAYS: readonly ChatDisplay[] = ["full", "collapseToolCalls", "collapseTurns"];

export function ChatSection() {
  const { t } = useTranslation();
  const toast = useToast();
  const { settings, updateSettings } = useAppSettings();
  const [archiveCommandDraft, setArchiveCommandDraft] = useState(settings.archiveCommand);
  const [archiveDraftDirty, setArchiveDraftDirty] = useState(false);
  const [archiveEditorRevision, setArchiveEditorRevision] = useState(0);

  useEffect(() => {
    if (!archiveDraftDirty && settings.archiveCommand !== archiveCommandDraft) {
      setArchiveCommandDraft(settings.archiveCommand);
      setArchiveEditorRevision((value) => value + 1);
    }
  }, [archiveCommandDraft, archiveDraftDirty, settings.archiveCommand]);

  const chatDisplayOptions = useMemo(
    () =>
      CHAT_DISPLAYS.map((value) => ({
        value,
        label: t(`settings.general.chatDisplay.options.${value}`),
      })),
    [t],
  );

  const changeChatDisplay = useCallback(
    (chatDisplay: ChatDisplay) => void updateSettings({ chatDisplay }),
    [updateSettings],
  );
  const changeAutoExpandReasoning = useCallback(
    (autoExpandReasoning: boolean) => void updateSettings({ autoExpandReasoning }),
    [updateSettings],
  );
  const changeChatOutline = useCallback(
    (chatOutlineEnabled: boolean) => void updateSettings({ chatOutlineEnabled }),
    [updateSettings],
  );
  const changeAutoArchiveAfterCleanup = useCallback(
    (autoArchiveAfterCleanup: boolean) => void updateSettings({ autoArchiveAfterCleanup }),
    [updateSettings],
  );
  const handleArchiveCommandChange = useCallback((text: string) => {
    setArchiveCommandDraft(text);
    setArchiveDraftDirty(true);
  }, []);
  const saveArchiveCommand = useCallback(
    async (
      value: string,
      toastKey: "sessionArchive.settings.savedToast" | "sessionArchive.settings.resetToast",
    ) => {
      await updateSettings({ archiveCommand: value });
      setArchiveCommandDraft(value);
      setArchiveDraftDirty(false);
      setArchiveEditorRevision((rev) => rev + 1);
      toast.show(t(toastKey), { variant: "success" });
    },
    [t, toast, updateSettings],
  );
  const handleSaveArchiveCommand = useCallback(() => {
    const trimmed = archiveCommandDraft.trim();
    if (!trimmed) {
      toast.error(t("sessionArchive.settings.emptyError"));
      return;
    }
    void saveArchiveCommand(trimmed, "sessionArchive.settings.savedToast");
  }, [archiveCommandDraft, saveArchiveCommand, t, toast]);
  const handleResetArchiveCommand = useCallback(() => {
    void saveArchiveCommand(DEFAULT_ARCHIVE_COMMAND, "sessionArchive.settings.resetToast");
  }, [saveArchiveCommand]);

  return (
    <View style={styles.sections}>
      <SettingsSection title={t("settings.appearance.detailLevel.title")}>
        <SettingsCard>
          <SettingsSwitch
            label={t("settings.general.autoExpandReasoning.label")}
            hint={t("settings.general.autoExpandReasoning.description")}
            value={settings.autoExpandReasoning}
            onValueChange={changeAutoExpandReasoning}
          />
          <SettingsSelect
            label={t("settings.general.chatDisplay.label")}
            hint={t("settings.general.chatDisplay.description")}
            value={settings.chatDisplay}
            options={chatDisplayOptions}
            onValueChange={changeChatDisplay}
          />
          {isNative ? null : (
            <SettingsSwitch
              label={t("settings.appearance.chatOutline.title")}
              hint={t("settings.appearance.chatOutline.description")}
              value={settings.chatOutlineEnabled}
              onValueChange={changeChatOutline}
            />
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("sessionArchive.settings.sectionTitle")}>
        <SettingsCard>
          <SettingsSwitch
            label={t("sessionArchive.settings.autoArchiveLabel")}
            hint={t("sessionArchive.settings.autoArchiveHint")}
            value={settings.autoArchiveAfterCleanup}
            onValueChange={changeAutoArchiveAfterCleanup}
          />
          <View style={styles.commandBlock}>
            <View style={styles.commandHeader}>
              <Text style={settingsStyles.rowTitle}>
                {t("sessionArchive.settings.commandLabel")}
              </Text>
              <Text style={settingsStyles.rowHint}>{t("sessionArchive.settings.commandHint")}</Text>
            </View>
            <View style={styles.commandInputFrame}>
              <SettingsTextArea
                key={archiveEditorRevision}
                testID="settings-archive-command-input"
                accessibilityLabel={t("sessionArchive.settings.commandLabel")}
                value={archiveCommandDraft}
                onChangeText={handleArchiveCommandChange}
                placeholder={t("sessionArchive.settings.commandPlaceholder")}
                style={styles.commandInput}
              />
            </View>
            <View style={styles.commandActions}>
              <Button
                variant="default"
                size="sm"
                onPress={handleSaveArchiveCommand}
                disabled={!archiveDraftDirty}
                testID="settings-archive-command-save"
              >
                {t("sessionArchive.settings.saveAction")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onPress={handleResetArchiveCommand}
                testID="settings-archive-command-reset"
              >
                {t("sessionArchive.settings.resetAction")}
              </Button>
            </View>
          </View>
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  sections: {
    gap: theme.spacing[6],
  },
  commandBlock: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  commandHeader: {
    gap: 2,
  },
  commandInputFrame: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  commandInput: {
    minHeight: 88,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  commandActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
}));
