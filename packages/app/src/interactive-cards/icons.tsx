import type { ComponentType } from "react";
import {
  Activity,
  AlertTriangle,
  Blocks,
  Bot,
  Check,
  CheckCircle2,
  Code,
  FileText,
  Folder,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Globe,
  History,
  Home,
  Inbox,
  Info,
  Layers,
  Link2,
  MessageSquare,
  Play,
  Puzzle,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Star,
  Terminal,
  Workflow,
  Wrench,
} from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { CardTone } from "@getpaseo/protocol/interactive-cards";
import type { Theme } from "@/styles/theme";

type LucideComponent = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

const ICON_MAP: Record<string, LucideComponent> = {
  activity: Activity,
  alert: AlertTriangle,
  warning: AlertTriangle,
  chart: Activity,
  blocks: Blocks,
  bot: Bot,
  check: Check,
  success: CheckCircle2,
  clock: History,
  history: History,
  code: Code,
  cpu: Server,
  server: Server,
  database: Layers,
  doc: FileText,
  file: FileText,
  folder: Folder,
  tree: FolderTree,
  gauge: Activity,
  branch: GitBranch,
  commit: GitCommitHorizontal,
  merge: GitMerge,
  pull_request: GitPullRequest,
  globe: Globe,
  home: Home,
  inbox: Inbox,
  mail: Inbox,
  info: Info,
  layers: Layers,
  link: Link2,
  list: Layers,
  chat: MessageSquare,
  message: MessageSquare,
  play: Play,
  plugin: Puzzle,
  extension: Puzzle,
  rocket: Workflow,
  workflow: Workflow,
  search: Search,
  settings: Settings,
  shield: ShieldCheck,
  sparkles: Blocks,
  star: Star,
  terminal: Terminal,
  tools: Wrench,
  wrench: Wrench,
  zap: Activity,
};

export function resolveCardIcon(name?: string): LucideComponent | null {
  if (!name) return null;
  return ICON_MAP[name.trim().toLowerCase()] ?? null;
}

export function toneColorForTheme(theme: Theme, tone?: CardTone): string {
  switch (tone) {
    case "muted":
      return theme.colors.foregroundMuted;
    case "accent":
      return theme.colors.accent;
    case "success":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "danger":
      return theme.colors.statusDanger;
    default:
      return theme.colors.foreground;
  }
}

export function toneTintForTheme(theme: Theme, tone?: CardTone): string {
  switch (tone) {
    case "accent":
      return `${theme.colors.accent}20`;
    case "success":
      return theme.colors.statusSuccessTint;
    case "warning":
      return theme.colors.statusWarningTint;
    case "danger":
      return theme.colors.statusDangerTint;
    case "muted":
      return theme.colors.surface2;
    default:
      return theme.colors.surface2;
  }
}

function CardIconInner({ name, size = 15, color }: { name: string; size?: number; color: string }) {
  const Icon = resolveCardIcon(name);
  if (!Icon) return null;
  return <Icon size={size} color={color} strokeWidth={1.75} />;
}

const ThemedCardIconInner = withUnistyles(CardIconInner);

const TONE_COLOR_MAPPINGS: Record<CardTone | "none", (theme: Theme) => { color: string }> = {
  none: (theme) => ({ color: theme.colors.foregroundMuted }),
  default: (theme) => ({ color: theme.colors.foreground }),
  muted: (theme) => ({ color: theme.colors.foregroundMuted }),
  accent: (theme) => ({ color: theme.colors.accent }),
  success: (theme) => ({ color: theme.colors.statusSuccess }),
  warning: (theme) => ({ color: theme.colors.statusWarning }),
  danger: (theme) => ({ color: theme.colors.statusDanger }),
};

export function ThemedCardIcon({
  name,
  tone,
  size = 15,
}: {
  name?: string;
  tone?: CardTone;
  size?: number;
}) {
  if (!name || !resolveCardIcon(name)) return null;
  return (
    <ThemedCardIconInner name={name} size={size} uniProps={TONE_COLOR_MAPPINGS[tone ?? "none"]} />
  );
}
