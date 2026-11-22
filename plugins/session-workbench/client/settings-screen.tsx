import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  Loading,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  useToast,
} from "@getpaseo/plugin/client/ui";
import {
  DEFAULT_ARCHIVE_COMMAND,
  workbenchSettings,
  type WorkbenchSettings,
} from "../shared/settings.js";

export function WorkbenchSettingsScreen({ theme }: PluginSurfaceProps) {
  const state = useSettings(workbenchSettings);
  const toast = useToast();
  const [archiveCommandDraft, setArchiveCommandDraft] = useState("");
  const [archiveDraftDirty, setArchiveDraftDirty] = useState(false);

  const persistedArchiveCommand = state.status === "ready" ? state.values.archiveCommand : "";
  useEffect(() => {
    if (state.status === "ready" && !archiveDraftDirty) {
      setArchiveCommandDraft(persistedArchiveCommand);
    }
  }, [archiveDraftDirty, persistedArchiveCommand, state.status]);

  const patch = useCallback(
    async (partial: Partial<WorkbenchSettings>) => {
      if (state.status !== "ready") return false;
      const ok = await state.save({ ...state.values, ...partial }, state.revision);
      if (!ok) {
        toast.error(state.saveError ?? "保存设置失败");
      }
      return ok;
    },
    [state, toast],
  );

  const handleSaveArchiveCommand = useCallback(async () => {
    const trimmed = archiveCommandDraft.trim();
    if (!trimmed) {
      toast.error("归档命令不能为空");
      return;
    }
    const ok = await patch({ archiveCommand: trimmed });
    if (ok) {
      setArchiveCommandDraft(trimmed);
      setArchiveDraftDirty(false);
      toast.show("已保存归档命令", { variant: "success" });
    }
  }, [archiveCommandDraft, patch, toast]);

  const handleResetArchiveCommand = useCallback(async () => {
    const ok = await patch({ archiveCommand: DEFAULT_ARCHIVE_COMMAND });
    if (ok) {
      setArchiveCommandDraft(DEFAULT_ARCHIVE_COMMAND);
      setArchiveDraftDirty(false);
      toast.show("已恢复默认归档命令", { variant: "success" });
    }
  }, [patch, toast]);

  if (state.status === "loading") {
    return <Loading />;
  }

  if (state.status !== "ready") {
    return (
      <View style={{ padding: 20 }}>
        <SettingsCard>
          <SettingsRow label="设置读取失败" hint={state.error} />
        </SettingsCard>
      </View>
    );
  }

  const values = state.values;

  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
      <SettingsSection title="卡片显示">
        <SettingsCard>
          <SettingsSwitch
            label="启用对话工作台"
            hint="在对话右上角显示工作台卡片，并在左侧栏展示状态总览入口"
            value={values.enabled}
            onValueChange={(enabled) => void patch({ enabled })}
          />
          <SettingsSwitch
            label="宽屏默认展开右上角卡片"
            hint="关闭后默认以紧凑胶囊停靠在右上角，点击展开完整卡片"
            value={values.defaultExpanded}
            onValueChange={(defaultExpanded) => void patch({ defaultExpanded })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="AI 自动总结（复用 Paseo Helper 链路）">
        <SettingsCard>
          <SettingsSwitch
            label="每轮结束后自动更新主题与当前工作"
            hint="通过后台隐藏 Helper Agent 增量总结，不出现在标签页和子代理列表中"
            value={values.autoSummarize}
            onValueChange={(autoSummarize) => void patch({ autoSummarize })}
          />
          <SettingsSwitch
            label="自动优先选用轻量摘要模型"
            hint="未填自定义模型时，优先选用同 Provider 或已就绪的 flash / haiku / mini 轻量模型提速省费"
            value={values.autoSelectLightModel}
            onValueChange={(autoSelectLightModel) => void patch({ autoSelectLightModel })}
          />
          <SettingsSwitch
            label="总结时自动降级/关闭思考模式"
            hint="加快摘要速度并降低 Token 消耗"
            value={values.disableSummaryThinking}
            onValueChange={(disableSummaryThinking) => void patch({ disableSummaryThinking })}
          />
          <SettingsInput
            label="自定义摘要模型（可选）"
            hint="填写后固定使用该模型；留空则按上方开关自动选轻量模型或沿用当前对话模型"
            initialValue={values.summaryCustomProviderModel}
            placeholder="例如：claude-magpie/agy-cli/gemini-3.8-flash[1m]"
            onChangeText={(summaryCustomProviderModel) =>
              void patch({ summaryCustomProviderModel: summaryCustomProviderModel.trim() })
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="AI 协作与 Fork 行为">
        <SettingsCard>
          <SettingsSwitch
            label="向对话注入工作台工具"
            hint="开启宿主的 Enable Paseo tools 后，AI 可主动调用 workbench_* 工具记录待办与更新状态"
            value={values.injectAgentTools}
            onValueChange={(injectAgentTools) => void patch({ injectAgentTools })}
          />
          <SettingsSwitch
            label="会话恢复时注入工作台摘要上下文"
            hint="在 agent.open.before 注入精简主题与未完成待办，避免长对话或重启后偏离目标"
            value={values.injectCardContextPrompt}
            onValueChange={(injectCardContextPrompt) => void patch({ injectCardContextPrompt })}
          />
          <SettingsSelect
            label="待办 Fork 默认上下文模式"
            hint="轻量摘要仅携带主题、当前进展与最近对话片段；完整历史复用 Paseo 原生 Fork 上下文"
            value={values.defaultForkContextMode}
            options={[
              { label: "轻量摘要上下文（推荐，省 Token）", value: "summary" },
              { label: "完整对话历史（Paseo Fork Context）", value: "full_history" },
            ]}
            onValueChange={(defaultForkContextMode) => void patch({ defaultForkContextMode })}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="对话归档">
        <SettingsCard>
          <SettingsSwitch
            label="AI 清理完成后自动归档并关闭标签页"
            hint="AI 确认无风险并调用 workbench_finish_archive 后，本轮结束自动归档对话并关闭当前标签页"
            value={values.autoArchiveAfterCleanup}
            onValueChange={(autoArchiveAfterCleanup) => void patch({ autoArchiveAfterCleanup })}
          />
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 14,
              gap: 8,
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
            }}
          >
            <View style={{ gap: 2 }}>
              <Text style={{ fontSize: 14, fontWeight: "500", color: theme.colors.foreground }}>
                归档命令 / 提示词
              </Text>
              <Text style={{ fontSize: 12, lineHeight: 17, color: theme.colors.foregroundMuted }}>
                点击卡片右上角归档按钮时直接发送到当前对话。既可写完整归档步骤，也可填单个斜杠命令或
                Skill 触发词（如 /archive-session）
              </Text>
            </View>
            <TextInput
              value={archiveCommandDraft}
              onChangeText={(text) => {
                setArchiveCommandDraft(text);
                setArchiveDraftDirty(true);
              }}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
              placeholder="输入点击归档后发送给 AI 的命令或归档步骤…"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                width: "100%",
                minHeight: 132,
                fontSize: 13,
                lineHeight: 19,
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface0,
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderRadius: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
              }}
            />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Pressable
                onPress={() => void handleSaveArchiveCommand()}
                disabled={!archiveDraftDirty}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  borderRadius: 7,
                  backgroundColor: theme.colors.accent,
                  opacity: archiveDraftDirty ? 1 : 0.45,
                }}
              >
                <Text
                  style={{
                    fontSize: 12,
                    fontWeight: "600",
                    color: theme.colors.accentForeground,
                  }}
                >
                  保存归档命令
                </Text>
              </Pressable>
              <Pressable
                onPress={() => void handleResetArchiveCommand()}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  borderRadius: 7,
                  backgroundColor: theme.colors.surface1,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                }}
              >
                <Text style={{ fontSize: 12, color: theme.colors.foregroundMuted }}>恢复默认</Text>
              </Pressable>
            </View>
          </View>
        </SettingsCard>
      </SettingsSection>
    </ScrollView>
  );
}
