export const SESSION_ARCHIVE_PLUGIN_ID = "session-archive";

export const DEFAULT_ARCHIVE_COMMAND = [
  "清理本对话产生的工程残留（worktree、临时分支、临时文件与临时终端），不要动其他并行对话的改动。",
  "如有未提交、未合并或冲突风险，先停下说明；确认干净后调用 session_finish_archive 并简短汇报。",
].join("\n");

export type SessionArchiveState = "idle" | "queued" | "running" | "pending_archive";
