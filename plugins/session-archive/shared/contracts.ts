import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const SESSION_ARCHIVE_PLUGIN_ID = "session-archive";

export const ArchiveStateSchema = z.enum(["idle", "queued", "running", "pending_archive"]);
export type ArchiveState = z.infer<typeof ArchiveStateSchema>;

export const ArchiveCompletedEventSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  archivedAt: z.string(),
  summary: z.string().nullable(),
});
export type ArchiveCompletedEvent = z.infer<typeof ArchiveCompletedEventSchema>;

export const triggerSessionArchiveRpc = defineRpc({
  name: "session.archive.trigger",
  input: z.object({
    agentId: z.string().min(1),
    workspaceId: z.string().nullable().optional(),
    command: z.string().optional(),
    autoArchiveAfterCleanup: z.boolean().optional(),
    cancelQueue: z.boolean().optional(),
  }),
  output: z.object({
    state: ArchiveStateSchema,
    status: z.enum(["sent", "queued", "canceled"]),
  }),
});

export const getSessionArchiveStateRpc = defineRpc({
  name: "session.archive.state",
  input: z.object({
    agentId: z.string().min(1),
  }),
  output: z.object({
    state: ArchiveStateSchema,
  }),
});

export const watchSessionArchiveStateSubscription = defineSubscription({
  name: "session.archive.state.watch",
  input: z.object({
    agentId: z.string().min(1),
  }),
  event: z.object({
    agentId: z.string(),
    state: ArchiveStateSchema,
  }),
});

export const sessionArchiveCompletedSubscription = defineSubscription({
  name: "session.archive.completed",
  input: z.object({}),
  event: ArchiveCompletedEventSchema,
});
