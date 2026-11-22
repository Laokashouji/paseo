import type { TFunction } from "i18next";
import { isAgentRunning } from "@getpaseo/protocol/agent-state-bucket";
import type { ComposerTrackPillSegment } from "@/composer/tracks";
import { STATUS_BUCKET_ORDER, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { BranchRow } from "./select";

function deriveBranchStatusBucket(row: BranchRow): SidebarStateBucket {
  const status =
    row.turn.phase === "open"
      ? "running"
      : row.status === "running"
        ? "idle"
        : row.status;
  if (status === "error") return "failed";
  if (isAgentRunning({ status, backgroundWork: row.backgroundWork })) return "running";
  return "done";
}

export interface BranchRowPresentationData {
  key: string;
  kind: "agent";
  label: string;
  titleState: "ready" | "loading";
  statusBucket: SidebarStateBucket | null;
}

export function buildBranchRowPresentationData(row: BranchRow): BranchRowPresentationData {
  const title = typeof row.title === "string" && row.title.trim().length > 0 ? row.title.trim() : null;
  return {
    key: `branch_${row.address.serverId}_${row.id}`,
    kind: "agent",
    label: title ?? "",
    titleState: title ? "ready" : "loading",
    statusBucket: deriveBranchStatusBucket(row),
  };
}

type ActiveStatusBucket = Exclude<SidebarStateBucket, "done">;

const ACTIVE_STATUS_BUCKET_ORDER = STATUS_BUCKET_ORDER.filter(
  (bucket): bucket is ActiveStatusBucket => bucket !== "done",
);

export interface BranchPillPresentation {
  segments: ComposerTrackPillSegment[];
  accessibilityLabel: string;
}

export function buildBranchPillPresentation(
  t: TFunction,
  rows: readonly BranchRow[],
): BranchPillPresentation {
  const totalLabel =
    rows.length === 1
      ? t("branches.pillLabelOne")
      : t("branches.pillLabelMany", { count: rows.length });

  const siblingBuckets = rows
    .filter((row) => !row.isCurrent)
    .map((row) => buildBranchRowPresentationData(row).statusBucket);

  const activeSegments: ComposerTrackPillSegment[] = ACTIVE_STATUS_BUCKET_ORDER.flatMap(
    (bucket) => {
      const count = siblingBuckets.filter((candidate) => candidate === bucket).length;
      if (count <= 0) return [];
      const text =
        bucket === "running"
          ? t("subagents.pillLabelWorking", { count })
          : bucket === "failed"
            ? t("subagents.pillLabelFailed", { count })
            : null;
      return text ? [{ bucket, text }] : [];
    },
  );

  const segments: ComposerTrackPillSegment[] = [
    { bucket: null, text: totalLabel },
    ...activeSegments,
  ];
  return {
    segments,
    accessibilityLabel: segments.map((segment) => segment.text).join(", "),
  };
}
