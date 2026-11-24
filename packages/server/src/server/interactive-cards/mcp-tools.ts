import { z } from "zod";
import { INTERACTIVE_CARD_TOOL_NAMES } from "@getpaseo/protocol/interactive-cards";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import type { AgentManager } from "../agent/agent-manager.js";
import { isPaseoToolEnabled } from "../agent/paseo-tool-policy.js";
import { ensureValidJson } from "../json-utils.js";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";
import type { InteractiveCardsService } from "./service.js";

export interface RegisterInteractiveCardToolsOptions {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    handler: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool inputs are validated by the catalog before execution.
      input: any,
      context: PaseoToolExecutionContext,
    ) => Promise<PaseoToolResult>,
  ) => void;
  agentManager: Pick<AgentManager, "getAgent">;
  interactiveCardsService?: InteractiveCardsService | null;
  callerAgentId?: string;
  scope: "agent" | "top-level";
  policy?: ProviderPaseoToolsPolicy;
}

const ViewObjectInputSchema = z.record(z.string(), z.unknown());

const ViewShowInputShape = {
  view: ViewObjectInputSchema.describe(
    "Declarative View JSON object with required plain-text `fallback`, `sections` (array of items such as row, field, button, segmented, table, chart, metric, stat_grid, progress, checklist, code, diff, file_tree, image, grid, carousel, text, markdown, divider, empty, loading), and optional named `pages` for drill-down. Never include secret/password fields or raw html.",
  ),
};

const ViewUpdateInputShape = {
  id: z
    .string()
    .min(1)
    .describe("The exact live card id returned by view_show (including its `view_` prefix)."),
  view: ViewObjectInputSchema.describe(
    "The complete replacement View object including required plain-text `fallback`.",
  ),
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Optional expected version from view_get/view_show; stale updates return a conflict instead of overwriting.",
    ),
};

const ViewGetInputShape = {
  id: z.string().min(1).describe("The exact live card id returned by view_show."),
};

function isBackgroundOrQuietSubagent(
  agent: ReturnType<Pick<AgentManager, "getAgent">["getAgent"]>,
): boolean {
  if (!agent) return false;
  if (agent.background === true) return true;
  if (agent.labels?.["main-chat.quiet"] === "true") return true;
  if (agent.labels?.["paseo.background"] === "true") return true;
  return false;
}

export function registerInteractiveCardTools(options: RegisterInteractiveCardToolsOptions): void {
  const { interactiveCardsService, callerAgentId, scope, agentManager, policy, registerTool } =
    options;
  if (!interactiveCardsService || scope !== "agent" || !callerAgentId) return;

  const caller = agentManager.getAgent(callerAgentId);
  if (isBackgroundOrQuietSubagent(caller)) return;

  if (isPaseoToolEnabled(policy, INTERACTIVE_CARD_TOOL_NAMES.show)) {
    registerTool(
      INTERACTIVE_CARD_TOOL_NAMES.show,
      {
        title: "Show interactive live card",
        description:
          "Create a persistent interactive live card in this conversation. Supports declarative sections (row choices, forms with toggle/choice/multichoice/text/multiline/number/date/time/datetime fields, buttons, tables, SVG charts, metrics, progress, checklists, code/diff/file_tree, and named drill-down pages). Keep key conclusions in normal reply text too, always provide a plain-text `fallback`, and never collect passwords or secrets. Do not use cards to replace blocking tool permission approvals or AskUserQuestion. Returns { id, version }.",
        inputSchema: ViewShowInputShape,
      },
      async (input: { view: Record<string, unknown> }) => {
        const result = await interactiveCardsService.showLiveCard({
          agentId: callerAgentId,
          view: input.view,
        });
        if (!result.ok) {
          const text = `view_show validation failed:\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
          return {
            isError: true,
            content: [{ type: "text", text }],
            structuredContent: ensureValidJson({ ok: false, errors: result.errors }),
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Created live card ${result.card.id} (version ${result.card.version}).`,
            },
          ],
          structuredContent: ensureValidJson({
            ok: true,
            id: result.card.id,
            version: result.card.version,
          }),
        };
      },
    );
  }

  if (isPaseoToolEnabled(policy, INTERACTIVE_CARD_TOOL_NAMES.update)) {
    registerTool(
      INTERACTIVE_CARD_TOOL_NAMES.update,
      {
        title: "Update interactive live card",
        description:
          "Replace a live card created by this conversation with a complete validated View. Stays anchored at its original timeline position; updates are coalesced to at most 1/s for connected clients. Supply `version` for optimistic concurrency control. Updating a card never clears an already-submitted user answer. Returns { id, version }.",
        inputSchema: ViewUpdateInputShape,
      },
      async (input: { id: string; view: Record<string, unknown>; version?: number }) => {
        const result = await interactiveCardsService.updateLiveCard({
          agentId: callerAgentId,
          id: input.id,
          view: input.view,
          expectedVersion: input.version,
        });
        if (!result.ok) {
          const text = `view_update failed (${result.code}):\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
          return {
            isError: true,
            content: [{ type: "text", text }],
            structuredContent: ensureValidJson({
              ok: false,
              code: result.code,
              errors: result.errors,
              ...(result.currentVersion !== undefined
                ? { currentVersion: result.currentVersion }
                : {}),
            }),
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Updated live card ${result.card.id} to version ${result.card.version}.`,
            },
          ],
          structuredContent: ensureValidJson({
            ok: true,
            id: result.card.id,
            version: result.card.version,
          }),
        };
      },
    );
  }

  if (isPaseoToolEnabled(policy, INTERACTIVE_CARD_TOOL_NAMES.get)) {
    registerTool(
      INTERACTIVE_CARD_TOOL_NAMES.get,
      {
        title: "Get interactive live card",
        description:
          "Read a live card created by this conversation, including its current `version`, full `view`, timestamps, and the user's committed `action` (selection, submitted field values, and pending/sent/failed delivery status).",
        inputSchema: ViewGetInputShape,
      },
      async (input: { id: string }) => {
        const result = await interactiveCardsService.getLiveCard({
          agentId: callerAgentId,
          id: input.id,
        });
        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: `view_get failed (${result.code}): ${result.error}` }],
            structuredContent: ensureValidJson({
              ok: false,
              code: result.code,
              error: result.error,
            }),
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Live card ${result.card.id} (v${result.card.version}), answered=${Boolean(result.action)}.`,
            },
          ],
          structuredContent: ensureValidJson({
            ok: true,
            id: result.card.id,
            version: result.card.version,
            view: result.card.view,
            createdAt: result.card.createdAt,
            updatedAt: result.card.updatedAt,
            action: result.action,
          }),
        };
      },
    );
  }
}
