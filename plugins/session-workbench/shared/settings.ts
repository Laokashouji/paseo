import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { ForkContextModeSchema } from "./schema.js";

export const workbenchSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  defaultExpanded: z.boolean().default(true),
  autoSummarize: z.boolean().default(true),
  summaryDebounceMs: z.number().int().min(500).max(30_000).default(3000),
  summaryCustomProviderModel: z.string().default(""),
  disableSummaryThinking: z.boolean().default(true),
  injectAgentTools: z.boolean().default(true),
  injectCardContextPrompt: z.boolean().default(true),
  defaultForkContextMode: ForkContextModeSchema.default("summary"),
});

export type WorkbenchSettings = z.infer<typeof workbenchSettingsSchema>;

export const DEFAULT_WORKBENCH_SETTINGS: WorkbenchSettings = workbenchSettingsSchema.parse({});

export const workbenchSettings = defineSettings({
  id: "session-workbench",
  scope: "host",
  version: 1,
  schema: workbenchSettingsSchema,
});
