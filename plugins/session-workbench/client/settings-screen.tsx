import { useCallback } from "react";
import { ScrollView, View } from "react-native";
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
import { workbenchSettings, type WorkbenchSettings } from "../shared/settings.js";

export function WorkbenchSettingsScreen(_props: PluginSurfaceProps) {
  const state = useSettings(workbenchSettings);
  const toast = useToast();

  const patch = useCallback(
    async (partial: Partial<WorkbenchSettings>) => {
      if (state.status !== "ready") return;
      const ok = await state.save({ ...state.values, ...partial }, state.revision);
      if (!ok) {
        toast.error(state.saveError ?? "保存设置失败");
      }
    },
    [state, toast],
  );

  if (state.status === "loading") {
    return <Loading />;
  }

  if (state.status !== "ready") {
    return (
      <View style={{ padding: 20 }}>
        <SettingsCard>
          <SettingsRow
            label="设置读取失败"
            hint={state.error}
          />
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
            label="总结时自动降级/关闭思考模式"
            hint="加快摘要速度并降低 Token 消耗"
            value={values.disableSummaryThinking}
            onValueChange={(disableSummaryThinking) => void patch({ disableSummaryThinking })}
          />
          <SettingsInput
            label="自定义摘要模型（可选）"
            hint="留空则沿用当前对话的 Provider 与模型；格式如 claude/claude-haiku-4-5"
            initialValue={values.summaryCustomProviderModel}
            placeholder="例如：claude/claude-haiku-4-5"
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
    </ScrollView>
  );
}
