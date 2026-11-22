import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FORK_MODE_LABEL,
  FORK_ROOT_AGENT_ID_LABEL,
  FORKED_FROM_AGENT_ID_LABEL,
  PARENT_AGENT_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import {
  buildNativeForkLabels,
  resolveForkAgentTitle,
  resolveNativeForkBoundary,
} from "./native-fork.js";
import { forkJsonlTreeSessionFile } from "./providers/pi/fork.js";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

function makeRow(
  seq: number,
  item: AgentTimelineRow["item"],
  extra?: { providerMessageId?: string; turnId?: string },
): AgentTimelineRow {
  return {
    seq,
    timestamp: `2026-11-22T00:00:0${seq}.000Z`,
    item,
    ...(extra?.providerMessageId ? { providerMessageId: extra.providerMessageId } : {}),
    ...(extra?.turnId ? { turnId: extra.turnId } : {}),
  };
}

describe("resolveNativeForkBoundary", () => {
  const rows: AgentTimelineRow[] = [
    makeRow(1, { type: "user_message", messageId: "u-1", text: "First prompt" }, { providerMessageId: "prov-u-1" }),
    makeRow(2, { type: "assistant_message", messageId: "a-1", text: "First reply" }),
    makeRow(3, { type: "user_message", messageId: "u-2", text: "Second prompt" }, { providerMessageId: "prov-u-2" }),
    makeRow(4, { type: "assistant_message", messageId: "a-2", text: "Second reply" }),
  ];

  it("returns empty boundary when neither cursor nor messageId is supplied", () => {
    expect(resolveNativeForkBoundary({ rows, timelineEpoch: "epoch-1" })).toEqual({});
  });

  it("returns empty boundary when forking at the latest completed turn", () => {
    expect(
      resolveNativeForkBoundary({
        rows,
        timelineEpoch: "epoch-1",
        boundaryCursor: { epoch: "epoch-1", seq: 4 },
        boundaryMessageId: "a-2",
      }),
    ).toEqual({});
  });

  it("resolves nextUserMessageId and current turn anchors when forking an earlier turn", () => {
    expect(
      resolveNativeForkBoundary({
        rows,
        timelineEpoch: "epoch-1",
        boundaryCursor: { epoch: "epoch-1", seq: 2 },
        boundaryMessageId: "a-1",
      }),
    ).toEqual({
      nextUserMessageId: "prov-u-2",
      currentTurnUserMessageId: "prov-u-1",
      boundaryAssistantMessageId: "a-1",
    });
  });

  it("rejects mismatched timeline epochs", () => {
    expect(() =>
      resolveNativeForkBoundary({
        rows,
        timelineEpoch: "epoch-2",
        boundaryCursor: { epoch: "epoch-1", seq: 2 },
      }),
    ).toThrow("Selected timeline position is no longer available.");
  });

  it("rejects unacknowledged client user prompts following the boundary", () => {
    const unackedRows: AgentTimelineRow[] = [
      makeRow(1, { type: "user_message", messageId: "u-1", text: "First" }, { providerMessageId: "prov-u-1" }),
      makeRow(2, { type: "assistant_message", messageId: "a-1", text: "Reply" }),
      makeRow(3, {
        type: "user_message",
        messageId: "client-only",
        clientMessageId: "client-only",
        text: "Pending",
      }),
    ];
    expect(() =>
      resolveNativeForkBoundary({
        rows: unackedRows,
        timelineEpoch: "epoch-1",
        boundaryCursor: { epoch: "epoch-1", seq: 2 },
      }),
    ).toThrow("Cannot fork before the provider acknowledges the following prompt.");
  });
});

describe("buildNativeForkLabels and resolveForkAgentTitle", () => {
  it("preserves fork root across nested forks and strips parent/open-tab labels", () => {
    const firstFork = buildNativeForkLabels({
      sourceAgentId: "agent-root",
      sourceLabels: {},
      extraLabels: {
        [PARENT_AGENT_ID_LABEL]: "should-strip",
        "paseo.open-agent-tab.client-1": "true",
        "custom.tag": "keep",
      },
    });
    expect(firstFork).toEqual({
      "custom.tag": "keep",
      [FORKED_FROM_AGENT_ID_LABEL]: "agent-root",
      [FORK_ROOT_AGENT_ID_LABEL]: "agent-root",
      [FORK_MODE_LABEL]: "native",
    });

    const nestedFork = buildNativeForkLabels({
      sourceAgentId: "agent-child",
      sourceLabels: firstFork,
    });
    expect(nestedFork).toEqual({
      [FORKED_FROM_AGENT_ID_LABEL]: "agent-child",
      [FORK_ROOT_AGENT_ID_LABEL]: "agent-root",
      [FORK_MODE_LABEL]: "native",
    });
  });

  it("prefers explicit branch title and falls back cleanly", () => {
    expect(resolveForkAgentTitle({ explicitTitle: "方案 B", sourceTitle: "主对话" })).toBe("方案 B");
    expect(resolveForkAgentTitle({ sourceTitle: "主对话" })).toBe("主对话 (fork)");
    expect(resolveForkAgentTitle({})).toBe("Forked conversation");
  });
});

describe("forkJsonlTreeSessionFile", () => {
  it("forks full active branch and truncates strictly before stopBeforeEntryId", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paseo-pi-fork-"));
    tempDirs.push(dir);
    const sourceFile = path.join(dir, "source.jsonl");
    const lines = [
      { type: "session", id: "orig-session", version: 2, cwd: "/repo/a", timestamp: "2026-11-22T00:00:00.000Z" },
      { type: "message", id: "e1", parentId: null, message: { role: "user", content: "Turn 1" } },
      { type: "message", id: "e2", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "Reply 1" }] } },
      { type: "message", id: "e-dead", parentId: "e1", message: { role: "assistant", content: [{ type: "text", text: "Abandoned branch" }] } },
      { type: "message", id: "e3", parentId: "e2", message: { role: "user", content: "Turn 2" } },
      { type: "message", id: "e4", parentId: "e3", message: { role: "assistant", content: [{ type: "text", text: "Reply 2" }] } },
    ];
    await writeFile(sourceFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

    const fullFork = await forkJsonlTreeSessionFile({
      sourceFile,
      targetCwd: "/repo/b",
    });
    expect(fullFork.sessionId).not.toBe("orig-session");
    const fullEntries = (await readFile(fullFork.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; id?: string; cwd?: string });
    expect(fullEntries[0]).toMatchObject({ type: "session", id: fullFork.sessionId, cwd: "/repo/b" });
    expect(fullEntries.slice(1).map((entry) => entry.id)).toEqual(["e1", "e2", "e3", "e4"]);

    const slicedFork = await forkJsonlTreeSessionFile({
      sourceFile,
      stopBeforeEntryId: "e3",
    });
    const slicedEntries = (await readFile(slicedFork.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: string });
    expect(slicedEntries.slice(1).map((entry) => entry.id)).toEqual(["e1", "e2"]);
  });
});
