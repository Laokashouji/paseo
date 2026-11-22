import type { PluginTheme } from "@getpaseo/plugin";
import type { RuntimeStatus, TodoStatus, WorkflowStatus } from "../shared/schema.js";

export function withAlpha(color: string, alpha: number): string {
  const trimmed = color.trim();
  const clamped = Math.max(0, Math.min(1, alpha));
  const hexShort = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (hexShort) {
    const [r, g, b] = hexShort[1]!.split("").map((ch) => parseInt(ch + ch, 16));
    return `rgba(${r}, ${g}, ${b}, ${clamped})`;
  }
  const hexFull = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hexFull) {
    const raw = hexFull[1]!;
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${clamped})`;
  }
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(trimmed);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${clamped})`;
  }
  return color;
}

export interface WorkflowStatusVisual {
  value: WorkflowStatus;
  label: string;
  shortLabel: string;
  icon: string;
  color(theme: PluginTheme): string;
  tintBg(theme: PluginTheme): string;
  tintBorder(theme: PluginTheme): string;
}

function makeVisual(input: {
  value: WorkflowStatus;
  label: string;
  shortLabel: string;
  icon: string;
  color(theme: PluginTheme): string;
}): WorkflowStatusVisual {
  return {
    ...input,
    tintBg: (theme) => withAlpha(input.color(theme), 0.14),
    tintBorder: (theme) => withAlpha(input.color(theme), 0.34),
  };
}

export const WORKFLOW_STATUS_LIST: readonly WorkflowStatusVisual[] = [
  makeVisual({
    value: "active",
    label: "推进中",
    shortLabel: "推进中",
    icon: "Play",
    color: (theme) => theme.colors.statusSuccess,
  }),
  makeVisual({
    value: "waiting_me",
    label: "待我处理",
    shortLabel: "待我处理",
    icon: "CircleDot",
    color: (theme) => theme.colors.statusWarning,
  }),
  makeVisual({
    value: "waiting_external",
    label: "等外部确认",
    shortLabel: "等外部",
    icon: "History",
    color: (theme) => theme.colors.statusWarning,
  }),
  makeVisual({
    value: "waiting_dependency",
    label: "等关联任务",
    shortLabel: "等关联",
    icon: "GitMerge",
    color: (theme) => theme.colors.accent,
  }),
  makeVisual({
    value: "snoozed",
    label: "暂挂",
    shortLabel: "暂挂",
    icon: "CircleSlash",
    color: (theme) => theme.colors.foregroundMuted,
  }),
  makeVisual({
    value: "done",
    label: "已完成",
    shortLabel: "已完成",
    icon: "CheckCircle2",
    color: (theme) => theme.colors.statusSuccess,
  }),
] as const;

export function getWorkflowStatusVisual(status: WorkflowStatus): WorkflowStatusVisual {
  return WORKFLOW_STATUS_LIST.find((item) => item.value === status) ?? WORKFLOW_STATUS_LIST[0]!;
}

export function getRuntimeStatusLabel(status: RuntimeStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "idle":
      return "空闲";
    case "initializing":
      return "启动中";
    case "error":
      return "异常";
    case "closed":
      return "已休眠";
    default:
      return "未知";
  }
}

export function getTodoStatusLabel(status: TodoStatus): string {
  switch (status) {
    case "open":
      return "待办";
    case "queued":
      return "已排队";
    case "running":
      return "执行中";
    case "forked":
      return "已 Fork";
    case "done":
      return "已完成";
    case "dismissed":
      return "已忽略";
  }
}
