import type { PluginHandlerContext } from "@getpaseo/plugin/server";

export type PaseoApi = PluginHandlerContext["paseo"];
export type PaseoAgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
export type PaseoAgent = NonNullable<ReturnType<PaseoAgentHandle["current"]>>;
export type PaseoAgentTimelineHandle = PaseoAgentHandle["timeline"];
