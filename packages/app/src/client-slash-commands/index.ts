import type { Agent } from "@/stores/session-store";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";

export type ClientSlashCommandKind =
  | "archive-agent"
  | "replace-agent-with-draft"
  | "branch-agent"
  | "side-question";
export type ClientSlashCommandExecution = "immediate" | "insert";
export type ClientSlashCommandArgsMode = "none" | "optional" | "required";

export interface ClientSlashCommand {
  name: string;
  aliases: readonly string[];
  description: string;
  descriptionKey:
    | "composer.clientCommands.archiveAgent"
    | "composer.clientCommands.freshDraft"
    | "composer.clientCommands.branchAgent"
    | "composer.clientCommands.sideQuestion";
  argumentHint: string;
  kind: ClientSlashCommandKind;
  execution: ClientSlashCommandExecution;
  argsMode: ClientSlashCommandArgsMode;
}

export interface ClientSlashCommandInvocation {
  command: ClientSlashCommand;
  args: string;
}

export const CLIENT_SLASH_COMMANDS: readonly ClientSlashCommand[] = [
  {
    name: "exit",
    aliases: ["quit", "q"],
    description: "Archive the current agent",
    descriptionKey: "composer.clientCommands.archiveAgent",
    argumentHint: "",
    kind: "archive-agent",
    execution: "immediate",
    argsMode: "none",
  },
  {
    name: "clear",
    aliases: ["new"],
    description: "Archive this agent and start a fresh draft",
    descriptionKey: "composer.clientCommands.freshDraft",
    argumentHint: "",
    kind: "replace-agent-with-draft",
    execution: "immediate",
    argsMode: "none",
  },
  {
    name: "branch",
    aliases: ["fork"],
    description: "Fork this conversation into a new branch tab",
    descriptionKey: "composer.clientCommands.branchAgent",
    argumentHint: "[name]",
    kind: "branch-agent",
    execution: "insert",
    argsMode: "optional",
  },
  {
    name: "btw",
    aliases: [],
    description: "Ask an ephemeral side question sharing this chat's cache",
    descriptionKey: "composer.clientCommands.sideQuestion",
    argumentHint: "<question>",
    kind: "side-question",
    execution: "insert",
    argsMode: "required",
  },
];

const COMMAND_BY_NAME = new Map<string, ClientSlashCommand>();
for (const command of CLIENT_SLASH_COMMANDS) {
  COMMAND_BY_NAME.set(command.name, command);
  for (const alias of command.aliases) {
    COMMAND_BY_NAME.set(alias, command);
  }
}

export function resolveClientSlashCommandInvocation(input: {
  text: string;
  hasAttachments: boolean;
}): ClientSlashCommandInvocation | null {
  if (input.hasAttachments) {
    return null;
  }

  const trimmed = input.text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const withoutSlash = trimmed.slice(1);
  if (!withoutSlash) {
    return null;
  }

  const firstWhitespace = withoutSlash.search(/\s/);
  const commandName =
    firstWhitespace === -1 ? withoutSlash : withoutSlash.slice(0, firstWhitespace);
  const args = firstWhitespace === -1 ? "" : withoutSlash.slice(firstWhitespace + 1).trim();
  const command = COMMAND_BY_NAME.get(commandName);
  if (!command) {
    return null;
  }

  if (command.argsMode === "none" && args.length > 0) {
    return null;
  }
  if (command.argsMode === "required" && args.length === 0) {
    return null;
  }

  return { command, args };
}

export function resolveClientSlashCommand(input: {
  text: string;
  hasAttachments: boolean;
}): ClientSlashCommand | null {
  return resolveClientSlashCommandInvocation(input)?.command ?? null;
}

export function buildDraftAgentSetup(agent: Agent): WorkspaceDraftTabSetup {
  return {
    provider: agent.provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    providerOptions: { ...agent.options },
  };
}
