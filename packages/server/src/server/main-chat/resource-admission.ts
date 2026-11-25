import os from "node:os";
import {
  type MainChatAdmissionQueueEntry,
  type MainChatHostResourceSnapshot,
  type MainChatHostResourceStatus,
  type MainChatResourceAdmissionPolicy,
  type MainChatResourceAdmissionSnapshot,
  type MainChatResourceAdmissionSummary,
  type MainChatResourcePressureReason,
  type MainChatTaskAdmissionState,
} from "@getpaseo/protocol/main-chat";

export interface LocalHostResourceSample {
  cpuPercent: number | null;
  loadAvg1m: number | null;
  cpuCores: number | null;
  freeMemoryMb: number | null;
  totalMemoryMb: number | null;
}

export type HostResourceSampler = (input: {
  serverId: string;
  isLocal: boolean;
}) => Promise<LocalHostResourceSample | null> | LocalHostResourceSample | null;

export class MainChatAdmissionRejectedError extends Error {
  readonly code = "resource_admission_rejected";
  readonly targetServerId: string;
  readonly hostLabel: string;
  readonly reasonCode: MainChatResourcePressureReason;
  readonly reason: string;
  readonly suggestion: string;
  readonly hostSnapshot: MainChatHostResourceSnapshot;

  constructor(input: {
    targetServerId: string;
    hostLabel: string;
    reasonCode: MainChatResourcePressureReason;
    reason: string;
    suggestion: string;
    hostSnapshot: MainChatHostResourceSnapshot;
  }) {
    super(`${input.reason}。建议：${input.suggestion}`);
    this.name = "MainChatAdmissionRejectedError";
    this.targetServerId = input.targetServerId;
    this.hostLabel = input.hostLabel;
    this.reasonCode = input.reasonCode;
    this.reason = input.reason;
    this.suggestion = input.suggestion;
    this.hostSnapshot = input.hostSnapshot;
  }
}

export function sampleLocalHostOsResources(): LocalHostResourceSample {
  const cpus = os.cpus();
  const cpuCores = cpus.length > 0 ? cpus.length : null;
  const loadAvg = os.loadavg();
  const rawLoad1m = Array.isArray(loadAvg) && typeof loadAvg[0] === "number" ? loadAvg[0] : null;
  const loadAvg1m =
    rawLoad1m !== null && Number.isFinite(rawLoad1m) ? Number(rawLoad1m.toFixed(2)) : null;
  const cpuPercent =
    loadAvg1m !== null && cpuCores !== null && cpuCores > 0
      ? Math.min(999, Math.max(0, Math.round((loadAvg1m / cpuCores) * 100)))
      : null;

  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const totalMemoryMb =
    Number.isFinite(totalBytes) && totalBytes > 0 ? Math.round(totalBytes / (1024 * 1024)) : null;
  const freeMemoryMb =
    Number.isFinite(freeBytes) && freeBytes >= 0 ? Math.round(freeBytes / (1024 * 1024)) : null;

  return {
    cpuPercent,
    loadAvg1m,
    cpuCores,
    freeMemoryMb,
    totalMemoryMb,
  };
}

export interface HostPressureDetail {
  code: MainChatResourcePressureReason;
  reason: string;
  suggestion: string;
}

export interface BuildHostResourceSnapshotInput {
  serverId: string;
  hostLabel: string;
  isLocal: boolean;
  connectivityStatus: "online" | "connecting" | "offline" | "error" | "degraded";
  activeManagedAgents: number;
  sample: LocalHostResourceSample | null;
  policy: MainChatResourceAdmissionPolicy;
  sampledAt: string;
}

export function collectHostPressureDetails(input: {
  hostLabel: string;
  connectivityStatus: "online" | "connecting" | "offline" | "error" | "degraded";
  activeManagedAgents: number;
  pendingReservations?: number;
  sample: LocalHostResourceSample | null;
  policy: MainChatResourceAdmissionPolicy;
}): HostPressureDetail[] {
  const details: HostPressureDetail[] = [];
  const label = input.hostLabel;

  if (
    input.connectivityStatus === "offline" ||
    input.connectivityStatus === "error" ||
    input.connectivityStatus === "connecting"
  ) {
    details.push({
      code: "host_offline",
      reason: `目标主机「${label}」当前离线或未连接（${input.connectivityStatus}）`,
      suggestion: "等待主机恢复在线，或改派到其他健康主机执行",
    });
  } else if (input.connectivityStatus === "degraded") {
    details.push({
      code: "host_degraded",
      reason: `目标主机「${label}」当前处于降级状态`,
      suggestion: "等待主机恢复健康，或切换到其他健康主机执行",
    });
  }

  const effectiveActive = Math.max(0, input.activeManagedAgents + (input.pendingReservations ?? 0));
  if (effectiveActive >= input.policy.maxConcurrentPerHost) {
    details.push({
      code: "concurrency_limit",
      reason: `主机「${label}」活跃受管并发已达上限（${effectiveActive}/${input.policy.maxConcurrentPerHost}）`,
      suggestion: "等待现有子任务释放槽位、切换到其他空闲主机，或调高单机并发上限",
    });
  }

  if (
    input.sample &&
    input.sample.cpuPercent !== null &&
    input.sample.cpuPercent >= input.policy.maxCpuPercent
  ) {
    details.push({
      code: "cpu_high",
      reason: `主机「${label}」CPU 负载过高（${input.sample.cpuPercent}% >= ${input.policy.maxCpuPercent}%）`,
      suggestion: "等待 CPU 负载回落、切换到空闲主机，或开启受压自动排队",
    });
  }

  if (
    input.sample &&
    input.sample.freeMemoryMb !== null &&
    input.sample.freeMemoryMb < input.policy.minFreeMemoryMb
  ) {
    details.push({
      code: "memory_low",
      reason: `主机「${label}」可用内存不足（${Math.round(input.sample.freeMemoryMb)} MB < ${input.policy.minFreeMemoryMb} MB）`,
      suggestion: "等待运行中任务释放内存、清理闲置子会话，或切换至内存充裕主机",
    });
  }

  return details;
}

export function buildHostResourceSnapshot(
  input: BuildHostResourceSnapshotInput,
): MainChatHostResourceSnapshot {
  const details = collectHostPressureDetails({
    hostLabel: input.hostLabel,
    connectivityStatus: input.connectivityStatus,
    activeManagedAgents: input.activeManagedAgents,
    sample: input.sample,
    policy: input.policy,
  });

  let status: MainChatHostResourceStatus = "healthy";
  if (details.some((entry) => entry.code === "host_offline")) {
    status = "offline";
  } else if (details.some((entry) => entry.code === "host_degraded")) {
    status = "degraded";
  } else if (details.length > 0) {
    status = "pressured";
  }

  return {
    serverId: input.serverId,
    hostLabel: input.hostLabel,
    isLocal: input.isLocal,
    status,
    cpuPercent: input.sample?.cpuPercent ?? null,
    loadAvg1m: input.sample?.loadAvg1m ?? null,
    cpuCores: input.sample?.cpuCores ?? null,
    freeMemoryMb: input.sample?.freeMemoryMb ?? null,
    totalMemoryMb: input.sample?.totalMemoryMb ?? null,
    activeManagedAgents: Math.max(0, input.activeManagedAgents),
    maxConcurrent: input.policy.maxConcurrentPerHost,
    pressureReasons: details.map((entry) => entry.code),
    pressureSummary: details.length > 0 ? details.map((entry) => entry.reason).join("；") : null,
    sampledAt: input.sampledAt,
  };
}

export type ResourceAdmissionEvaluation =
  | {
      verdict: "allow";
      hostSnapshot: MainChatHostResourceSnapshot;
    }
  | {
      verdict: "queue" | "reject";
      hostSnapshot: MainChatHostResourceSnapshot;
      reasonCode: MainChatResourcePressureReason;
      reason: string;
      suggestion: string;
      allReasons: MainChatResourcePressureReason[];
    };

function resolveHostConnectivityStatus(
  status: MainChatHostResourceStatus,
): "online" | "offline" | "degraded" {
  if (status === "offline") return "offline";
  if (status === "degraded") return "degraded";
  return "online";
}

function resolvePressuredHostStatus(
  code: MainChatResourcePressureReason,
): MainChatHostResourceStatus {
  if (code === "host_offline") return "offline";
  if (code === "host_degraded") return "degraded";
  return "pressured";
}

export function evaluateHostResourceAdmission(input: {
  host: MainChatHostResourceSnapshot;
  policy: MainChatResourceAdmissionPolicy;
  pendingReservations?: number;
}): ResourceAdmissionEvaluation {
  if (!input.policy.enabled) {
    return { verdict: "allow", hostSnapshot: input.host };
  }

  const connectivityStatus = resolveHostConnectivityStatus(input.host.status);

  const details = collectHostPressureDetails({
    hostLabel: input.host.hostLabel,
    connectivityStatus,
    activeManagedAgents: input.host.activeManagedAgents,
    pendingReservations: input.pendingReservations,
    sample: {
      cpuPercent: input.host.cpuPercent,
      loadAvg1m: input.host.loadAvg1m,
      cpuCores: input.host.cpuCores,
      freeMemoryMb: input.host.freeMemoryMb,
      totalMemoryMb: input.host.totalMemoryMb,
    },
    policy: input.policy,
  });

  if (details.length === 0) {
    return { verdict: "allow", hostSnapshot: input.host };
  }

  const primary = details[0]!;
  return {
    verdict: input.policy.queueWhenPressured ? "queue" : "reject",
    hostSnapshot: {
      ...input.host,
      status: resolvePressuredHostStatus(primary.code),
      pressureReasons: details.map((entry) => entry.code),
      pressureSummary: details.map((entry) => entry.reason).join("；"),
    },
    reasonCode: primary.code,
    reason: details.map((entry) => entry.reason).join("；"),
    suggestion: primary.suggestion,
    allReasons: details.map((entry) => entry.code),
  };
}

export function recalculateAdmissionQueuePositions(
  queue: readonly MainChatAdmissionQueueEntry[],
): MainChatAdmissionQueueEntry[] {
  return queue.map((entry, idx) => ({
    ...entry,
    position: idx + 1,
  }));
}

export function summarizeResourceAdmission(
  policy: MainChatResourceAdmissionPolicy,
  hosts: readonly MainChatHostResourceSnapshot[],
  queue: readonly MainChatAdmissionQueueEntry[],
): MainChatResourceAdmissionSummary {
  let healthyHosts = 0;
  let pressuredHosts = 0;
  let offlineHosts = 0;
  let totalActiveManagedAgents = 0;

  for (const host of hosts) {
    totalActiveManagedAgents += host.activeManagedAgents;
    if (host.status === "healthy") {
      healthyHosts += 1;
    } else if (host.status === "offline") {
      offlineHosts += 1;
    } else {
      pressuredHosts += 1;
    }
  }

  return {
    enabled: policy.enabled,
    totalHosts: hosts.length,
    healthyHosts,
    pressuredHosts,
    offlineHosts,
    queuedCount: queue.length,
    totalActiveManagedAgents,
  };
}

export function buildResourceAdmissionSnapshot(input: {
  policy: MainChatResourceAdmissionPolicy;
  hosts: readonly MainChatHostResourceSnapshot[];
  queue: readonly MainChatAdmissionQueueEntry[];
  updatedAt: string;
}): MainChatResourceAdmissionSnapshot {
  const normalizedQueue = recalculateAdmissionQueuePositions(input.queue);
  return {
    policy: input.policy,
    hosts: [...input.hosts],
    queue: normalizedQueue,
    summary: summarizeResourceAdmission(input.policy, input.hosts, normalizedQueue),
    updatedAt: input.updatedAt,
  };
}

export function createTaskQueuedAdmissionState(
  entry: MainChatAdmissionQueueEntry,
): MainChatTaskAdmissionState {
  return {
    status: "queued",
    queueId: entry.id,
    position: entry.position,
    targetServerId: entry.targetServerId,
    hostLabel: entry.hostLabel,
    reasonCode: entry.reasonCode,
    reason: entry.reason,
    suggestion: entry.suggestion,
    updatedAt: entry.lastEvaluatedAt,
  };
}

export function createTaskRejectedAdmissionState(input: {
  targetServerId: string;
  hostLabel: string;
  reasonCode: MainChatResourcePressureReason;
  reason: string;
  suggestion: string;
  updatedAt: string;
}): MainChatTaskAdmissionState {
  return {
    status: "rejected",
    queueId: null,
    position: null,
    targetServerId: input.targetServerId,
    hostLabel: input.hostLabel,
    reasonCode: input.reasonCode,
    reason: input.reason,
    suggestion: input.suggestion,
    updatedAt: input.updatedAt,
  };
}

export function createAdmissionQueueId(): string {
  return `aq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
