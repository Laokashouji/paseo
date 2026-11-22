import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { ForkContextModeSchema } from "./schema.js";

export const DEFAULT_ARCHIVE_COMMAND = [
  "请执行当前对话的归档收尾：",
  "1. 核对并清理本对话产生的工程残留：检查本对话创建的 git worktree（如 .worktrees/*）与临时分支，确认改动已按预期合入或提交后安全删除 worktree；清理本对话留下的未跟踪临时文件、调试脚本、临时日志与截图；关闭本对话开启的临时终端或后台进程。",
  "2. 严禁修改、回滚或删除同工作区其他并行对话正在使用的 worktree、分支或未提交改动。",
  "3. 如果发现存在未提交代码、未合并提交、合入冲突或其他需要我拍板的风险，请停止清理，明确列出具体路径与状态等待我确认，不要调用 workbench_finish_archive。",
  "4. 确认本对话的工程残留已全部处理干净且工作区安全后，调用 workbench_finish_archive 工具（附简短清理摘要），并在最终回复中简洁汇报本次归档清理结果。",
].join("\n");

export const workbenchSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  defaultExpanded: z.boolean().default(true),
  autoSummarize: z.boolean().default(true),
  autoSelectLightModel: z.boolean().default(true),
  summaryDebounceMs: z.number().int().min(500).max(30_000).default(3000),
  summaryCustomProviderModel: z.string().default(""),
  disableSummaryThinking: z.boolean().default(true),
  injectAgentTools: z.boolean().default(true),
  injectCardContextPrompt: z.boolean().default(true),
  defaultForkContextMode: ForkContextModeSchema.default("summary"),
  archiveCommand: z.string().default(DEFAULT_ARCHIVE_COMMAND),
  autoArchiveAfterCleanup: z.boolean().default(true),
});

export type WorkbenchSettings = z.infer<typeof workbenchSettingsSchema>;

export const DEFAULT_WORKBENCH_SETTINGS: WorkbenchSettings = workbenchSettingsSchema.parse({});

export const workbenchSettings = defineSettings({
  id: "session-workbench",
  scope: "host",
  version: 1,
  schema: workbenchSettingsSchema,
});
