import type {
  MainChatHostResourceStatus,
  MainChatResourcePressureReason,
  MainChatTaskAdmissionState,
  MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";

export interface TaskAdmissionBadgeDescriptor {
  status: "queued" | "rejected";
  variant: StatusBadgeVariant;
  queueId: string | null;
  position: number | null;
  hostLabel: string | null;
  reasonCode: MainChatResourcePressureReason | null;
  reason: string | null;
  suggestion: string | null;
}

export function deriveTaskAdmissionBadge(
  admissionState: MainChatTaskAdmissionState | null | undefined,
): TaskAdmissionBadgeDescriptor | null {
  if (!admissionState) return null;
  if (admissionState.status === "queued") {
    return {
      status: "queued",
      variant: "warning",
      queueId: admissionState.queueId,
      position: admissionState.position,
      hostLabel: admissionState.hostLabel,
      reasonCode: admissionState.reasonCode,
      reason: admissionState.reason,
      suggestion: admissionState.suggestion,
    };
  }
  if (admissionState.status === "rejected") {
    return {
      status: "rejected",
      variant: "error",
      queueId: null,
      position: null,
      hostLabel: admissionState.hostLabel,
      reasonCode: admissionState.reasonCode,
      reason: admissionState.reason,
      suggestion: admissionState.suggestion,
    };
  }
  return null;
}

export function isTaskAdmissionQueued(
  task: Pick<MainChatTaskRecord, "admissionState"> | null | undefined,
): boolean {
  return task?.admissionState?.status === "queued";
}

export function hostResourceStatusBadgeVariant(
  status: MainChatHostResourceStatus,
): StatusBadgeVariant {
  switch (status) {
    case "healthy":
      return "success";
    case "pressured":
    case "degraded":
      return "warning";
    case "offline":
      return "error";
  }
}
