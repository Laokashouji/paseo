import { isMainChatAgent } from "@getpaseo/protocol/main-chat";
import type { SessionState } from "@/stores/session-store";
import type { FileMentionRange } from "@/utils/file-mention-autocomplete";
import { isMainChatDedicatedWorkspace } from "./selectors";

export type MainChatMentionKind = "host" | "workspace" | "repo" | "session" | "skill";

export interface MainChatMentionHostSource {
  serverId: string;
  label: string;
  hostname?: string | null;
  online?: boolean;
}

export interface MainChatMentionWorkspaceSource {
  serverId: string;
  hostLabel?: string | null;
  workspaceId: string;
  name: string;
  directory: string;
  projectName?: string | null;
  branch?: string | null;
}

export interface MainChatMentionRepoSource {
  serverId: string;
  hostLabel?: string | null;
  projectId: string;
  name: string;
  rootPath: string;
}

export interface MainChatMentionSessionSource {
  serverId: string;
  hostLabel?: string | null;
  agentId: string;
  title: string;
  cwd?: string | null;
  status?: string | null;
}

export interface MainChatMentionSkillSource {
  name: string;
  description?: string | null;
  argumentHint?: string | null;
}

export interface MainChatMentionSourceCollection {
  hosts: readonly MainChatMentionHostSource[];
  workspaces: readonly MainChatMentionWorkspaceSource[];
  repos: readonly MainChatMentionRepoSource[];
  sessions: readonly MainChatMentionSessionSource[];
  skills: readonly MainChatMentionSkillSource[];
}

export interface BuildMainChatMentionItemsInput {
  query: string;
  hosts?: readonly MainChatMentionHostSource[];
  workspaces?: readonly MainChatMentionWorkspaceSource[];
  repos?: readonly MainChatMentionRepoSource[];
  sessions?: readonly MainChatMentionSessionSource[];
  skills?: readonly MainChatMentionSkillSource[];
  limitPerCategory?: number;
  maxTotal?: number;
}

export interface MainChatMentionMetadata {
  serverId?: string;
  workspaceId?: string;
  projectId?: string;
  agentId?: string;
  path?: string;
  skillName?: string;
}

export interface MainChatMentionItem {
  id: string;
  kind: MainChatMentionKind;
  title: string;
  label: string;
  subtitle: string;
  injectionToken: string;
  metadata: MainChatMentionMetadata;
}

export const EMPTY_MENTION_SOURCE_COLLECTION: MainChatMentionSourceCollection = {
  hosts: [],
  workspaces: [],
  repos: [],
  sessions: [],
  skills: [],
};

const DEFAULT_LIMIT_PER_CATEGORY = 4;
const DEFAULT_MAX_TOTAL = 16;

const CATEGORY_ORDER: Record<MainChatMentionKind, number> = {
  host: 0,
  workspace: 1,
  repo: 2,
  session: 3,
  skill: 4,
};

const CATEGORY_ALIASES: Record<MainChatMentionKind, readonly string[]> = {
  host: ["host", "主机", "zhuji", "zj", "server", "machine"],
  workspace: ["workspace", "ws", "工作区", "gongzuoqu", "gzq", "dir"],
  repo: ["repo", "repository", "仓库", "cangku", "ck", "project", "xiangmu"],
  session: ["session", "agent", "会话", "huihua", "hh", "chat", "duihua"],
  skill: ["skill", "技能", "jineng", "jn", "command"],
};

const CATEGORY_PREFIX: Record<MainChatMentionKind, string> = {
  host: "host",
  workspace: "workspace",
  repo: "repo",
  session: "session",
  skill: "skill",
};

// Lightweight pinyin table for common Chinese engineering/workspace terms so pinyin
// queries match Chinese titles without bundling a multi-megabyte dictionary.
const PINYIN_TERM_MAP: ReadonlyArray<readonly [string, string, string]> = [
  ["主机", "zhuji", "zj"],
  ["工作区", "gongzuoqu", "gzq"],
  ["仓库", "cangku", "ck"],
  ["会话", "huihua", "hh"],
  ["技能", "jineng", "jn"],
  ["主对话", "zhuduihua", "zdh"],
  ["对话", "duihua", "dh"],
  ["支付", "zhifu", "zf"],
  ["订单", "dingdan", "dd"],
  ["用户", "yonghu", "yh"],
  ["权限", "quanxian", "qx"],
  ["安全", "anquan", "aq"],
  ["测试", "ceshi", "cs"],
  ["发布", "fabu", "fb"],
  ["部署", "bushu", "bs"],
  ["重构", "chonggou", "cg"],
  ["修复", "xiufu", "xf"],
  ["排查", "paicha", "pc"],
  ["性能", "xingneng", "xn"],
  ["优化", "youhua", "yh"],
  ["审查", "shencha", "sc"],
  ["监控", "jiankong", "jk"],
  ["配置", "peizhi", "pz"],
  ["日志", "rizhi", "rz"],
  ["接口", "jiekou", "jk"],
  ["数据", "shuju", "sj"],
  ["服务", "fuwu", "fw"],
  ["前端", "qianduan", "qd"],
  ["后端", "houduan", "hd"],
  ["客户端", "kehuduan", "khd"],
  ["移动端", "yidongduan", "ydd"],
  ["桌面", "zhuomian", "zm"],
  ["任务", "renwu", "rw"],
  ["督办", "duban", "db"],
  ["巡检", "xunjian", "xj"],
  ["代码", "daima", "dm"],
  ["分支", "fenzhi", "fz"],
  ["合并", "hebing", "hb"],
  ["文档", "wendang", "wd"],
  ["脚本", "jiaoben", "jb"],
  ["编译", "bianyi", "by"],
  ["构建", "goujian", "gj"],
  ["首页", "shouye", "sy"],
  ["登录", "denglu", "dl"],
  ["搜索", "sousuo", "ss"],
  ["消息", "xiaoxi", "xx"],
  ["调度", "diaodu", "dd"],
  ["环境", "huanjing", "hj"],
  ["开发", "kaifa", "kf"],
];

function extractAsciiAcronym(text: string): string {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (words.length <= 1) return "";
  return words.map((word) => word[0]!.toLowerCase()).join("");
}

function buildPinyinAliases(text: string): string[] {
  const aliases: string[] = [];
  for (const [hanzi, fullPinyin, initials] of PINYIN_TERM_MAP) {
    if (text.includes(hanzi)) {
      aliases.push(fullPinyin, initials);
    }
  }
  const acronym = extractAsciiAcronym(text);
  if (acronym) {
    aliases.push(acronym);
  }
  return aliases;
}

function isOrderedSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true;
  let needleIndex = 0;
  for (let i = 0; i < haystack.length && needleIndex < needle.length; i += 1) {
    if (haystack[i] === needle[needleIndex]) {
      needleIndex += 1;
    }
  }
  return needleIndex === needle.length;
}

function scoreFieldMatch(query: string, rawField: string, weight: number): number | null {
  const field = rawField.trim().toLowerCase();
  if (!field) return null;
  if (field === query) return weight + 100;
  if (field.startsWith(query)) return weight + 70;
  const idx = field.indexOf(query);
  if (idx >= 0) return weight + 40 - Math.min(idx, 20);
  if (query.length >= 2 && isOrderedSubsequence(query, field)) {
    return weight + 10;
  }
  return null;
}

interface CandidateMentionEntry {
  item: MainChatMentionItem;
  searchFields: readonly string[];
  aliases: readonly string[];
}

function parseCategoryScopedQuery(rawQuery: string): {
  categoryFilter: MainChatMentionKind | null;
  termQuery: string;
} {
  const normalized = rawQuery.trim().toLowerCase();
  if (!normalized) {
    return { categoryFilter: null, termQuery: "" };
  }
  const colonIdx = normalized.indexOf(":");
  if (colonIdx > 0) {
    const prefix = normalized.slice(0, colonIdx);
    const rest = normalized.slice(colonIdx + 1).trim();
    for (const [kind, aliases] of Object.entries(CATEGORY_ALIASES) as Array<
      [MainChatMentionKind, readonly string[]]
    >) {
      if (aliases.includes(prefix)) {
        return { categoryFilter: kind, termQuery: rest };
      }
    }
  }
  return { categoryFilter: null, termQuery: normalized };
}

function scoreCandidate(
  candidate: CandidateMentionEntry,
  categoryFilter: MainChatMentionKind | null,
  termQuery: string,
): number | null {
  if (categoryFilter && candidate.item.kind !== categoryFilter) {
    return null;
  }
  if (!termQuery) {
    return 10 - CATEGORY_ORDER[candidate.item.kind];
  }

  let best: number | null = null;
  const recordScore = (score: number | null) => {
    if (score !== null && (best === null || score > best)) {
      best = score;
    }
  };

  recordScore(scoreFieldMatch(termQuery, candidate.item.title, 60));
  for (const field of candidate.searchFields) {
    recordScore(scoreFieldMatch(termQuery, field, 30));
  }
  for (const alias of candidate.aliases) {
    recordScore(scoreFieldMatch(termQuery, alias, 20));
  }
  for (const catAlias of CATEGORY_ALIASES[candidate.item.kind]) {
    if (catAlias === termQuery || catAlias.startsWith(termQuery)) {
      recordScore(25);
    }
  }
  return best;
}

function sanitizeTokenSegment(value: string): string {
  return value.replace(/[[\]\r\n]/g, " ").trim();
}

function buildHostCandidates(hosts: readonly MainChatMentionHostSource[]): CandidateMentionEntry[] {
  const seen = new Set<string>();
  const entries: CandidateMentionEntry[] = [];
  for (const host of hosts) {
    if (!host.serverId || seen.has(host.serverId)) continue;
    seen.add(host.serverId);
    const title = host.label.trim() || host.hostname?.trim() || host.serverId;
    const hostSuffix =
      host.hostname && host.hostname !== title
        ? `${host.hostname} · ${host.serverId}`
        : host.serverId;
    const token = `[@${CATEGORY_PREFIX.host}:${sanitizeTokenSegment(title)} (${host.serverId})]`;
    entries.push({
      item: {
        id: `host:${host.serverId}`,
        kind: "host",
        title,
        label: `@${title}`,
        subtitle: hostSuffix,
        injectionToken: token,
        metadata: { serverId: host.serverId },
      },
      searchFields: [host.serverId, host.hostname ?? "", hostSuffix],
      aliases: buildPinyinAliases(title),
    });
  }
  return entries;
}

function buildWorkspaceCandidates(
  workspaces: readonly MainChatMentionWorkspaceSource[],
): CandidateMentionEntry[] {
  const seen = new Set<string>();
  const entries: CandidateMentionEntry[] = [];
  for (const ws of workspaces) {
    const key = `${ws.serverId}:${ws.workspaceId}`;
    if (!ws.workspaceId || seen.has(key)) continue;
    seen.add(key);
    const title = ws.name.trim() || ws.projectName?.trim() || ws.workspaceId;
    const subtitleParts = [ws.hostLabel, ws.branch, ws.directory].filter((part): part is string =>
      Boolean(part && part.trim().length > 0),
    );
    const pathPart = ws.directory ? ` (${sanitizeTokenSegment(ws.directory)})` : "";
    const token = `[@${CATEGORY_PREFIX.workspace}:${sanitizeTokenSegment(title)}${pathPart}]`;
    entries.push({
      item: {
        id: `workspace:${key}`,
        kind: "workspace",
        title,
        label: `@${title}`,
        subtitle: subtitleParts.join(" · "),
        injectionToken: token,
        metadata: {
          serverId: ws.serverId,
          workspaceId: ws.workspaceId,
          path: ws.directory,
        },
      },
      searchFields: [ws.directory, ws.projectName ?? "", ws.branch ?? "", ws.hostLabel ?? ""],
      aliases: buildPinyinAliases(`${title} ${ws.projectName ?? ""}`),
    });
  }
  return entries;
}

function buildRepoCandidates(repos: readonly MainChatMentionRepoSource[]): CandidateMentionEntry[] {
  const seen = new Set<string>();
  const entries: CandidateMentionEntry[] = [];
  for (const repo of repos) {
    const dedupeKey = `${repo.serverId}:${repo.rootPath || repo.projectId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const title = repo.name.trim() || repo.rootPath || repo.projectId;
    const subtitle = [repo.hostLabel, repo.rootPath].filter(Boolean).join(" · ");
    const pathPart = repo.rootPath ? ` (${sanitizeTokenSegment(repo.rootPath)})` : "";
    const token = `[@${CATEGORY_PREFIX.repo}:${sanitizeTokenSegment(title)}${pathPart}]`;
    entries.push({
      item: {
        id: `repo:${repo.serverId}:${repo.projectId}`,
        kind: "repo",
        title,
        label: `@${title}`,
        subtitle,
        injectionToken: token,
        metadata: {
          serverId: repo.serverId,
          projectId: repo.projectId,
          path: repo.rootPath,
        },
      },
      searchFields: [repo.rootPath, repo.projectId, repo.hostLabel ?? ""],
      aliases: buildPinyinAliases(title),
    });
  }
  return entries;
}

function buildSessionCandidates(
  sessions: readonly MainChatMentionSessionSource[],
): CandidateMentionEntry[] {
  const seen = new Set<string>();
  const entries: CandidateMentionEntry[] = [];
  for (const session of sessions) {
    const key = `${session.serverId}:${session.agentId}`;
    if (!session.agentId || seen.has(key)) continue;
    seen.add(key);
    const title = session.title.trim() || session.agentId;
    const subtitle = [session.hostLabel, session.status, session.cwd]
      .filter((part): part is string => Boolean(part && part.trim().length > 0))
      .join(" · ");
    const token = `[@${CATEGORY_PREFIX.session}:${sanitizeTokenSegment(title)} (${session.agentId})]`;
    entries.push({
      item: {
        id: `session:${key}`,
        kind: "session",
        title,
        label: `@${title}`,
        subtitle,
        injectionToken: token,
        metadata: {
          serverId: session.serverId,
          agentId: session.agentId,
          path: session.cwd ?? undefined,
        },
      },
      searchFields: [
        session.agentId,
        session.cwd ?? "",
        session.hostLabel ?? "",
        session.status ?? "",
      ],
      aliases: buildPinyinAliases(title),
    });
  }
  return entries;
}

function buildSkillCandidates(
  skills: readonly MainChatMentionSkillSource[],
): CandidateMentionEntry[] {
  const seen = new Set<string>();
  const entries: CandidateMentionEntry[] = [];
  for (const skill of skills) {
    const normalizedName = skill.name.trim().replace(/^\/+/, "");
    if (!normalizedName || seen.has(normalizedName.toLowerCase())) continue;
    seen.add(normalizedName.toLowerCase());
    const subtitle = [skill.description, skill.argumentHint]
      .filter((part): part is string => Boolean(part && part.trim().length > 0))
      .join(" · ");
    const token = `[@${CATEGORY_PREFIX.skill}:/${sanitizeTokenSegment(normalizedName)}]`;
    entries.push({
      item: {
        id: `skill:${normalizedName}`,
        kind: "skill",
        title: normalizedName,
        label: `@/${normalizedName}`,
        subtitle,
        injectionToken: token,
        metadata: { skillName: normalizedName },
      },
      searchFields: [normalizedName, skill.description ?? "", skill.argumentHint ?? ""],
      aliases: buildPinyinAliases(`${normalizedName} ${skill.description ?? ""}`),
    });
  }
  return entries;
}

/**
 * Pure multi-source aggregator for Main Chat `@` mentions. Combines hosts, workspaces,
 * repositories, active sessions, and skills with category-prefix support, substring/pinyin/fuzzy
 * filtering, and balanced per-category caps.
 */
export function buildMainChatMentionItems(
  input: BuildMainChatMentionItemsInput,
): MainChatMentionItem[] {
  const limitPerCategory = Math.max(1, input.limitPerCategory ?? DEFAULT_LIMIT_PER_CATEGORY);
  const maxTotal = Math.max(1, input.maxTotal ?? DEFAULT_MAX_TOTAL);
  const { categoryFilter, termQuery } = parseCategoryScopedQuery(input.query);

  const allCandidates: CandidateMentionEntry[] = [
    ...buildHostCandidates(input.hosts ?? []),
    ...buildWorkspaceCandidates(input.workspaces ?? []),
    ...buildRepoCandidates(input.repos ?? []),
    ...buildSessionCandidates(input.sessions ?? []),
    ...buildSkillCandidates(input.skills ?? []),
  ];

  const scored: Array<{ item: MainChatMentionItem; score: number }> = [];
  for (const candidate of allCandidates) {
    const score = scoreCandidate(candidate, categoryFilter, termQuery);
    if (score !== null) {
      scored.push({ item: candidate.item, score });
    }
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const catDiff = CATEGORY_ORDER[left.item.kind] - CATEGORY_ORDER[right.item.kind];
    if (catDiff !== 0) return catDiff;
    return left.item.title.localeCompare(right.item.title);
  });

  const countByKind: Record<MainChatMentionKind, number> = {
    host: 0,
    workspace: 0,
    repo: 0,
    session: 0,
    skill: 0,
  };
  const results: MainChatMentionItem[] = [];
  for (const entry of scored) {
    if (results.length >= maxTotal) break;
    if (countByKind[entry.item.kind] >= limitPerCategory) continue;
    countByKind[entry.item.kind] += 1;
    results.push(entry.item);
  }
  return results;
}

export function replaceMentionRangeWithToken(input: {
  text: string;
  mention: FileMentionRange;
  token: string;
}): string {
  const before = input.text.slice(0, input.mention.start);
  const after = input.text.slice(input.mention.end);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const needsTrailingSpace = after.length === 0 || !/^\s/.test(after);
  return `${before}${needsLeadingSpace ? " " : ""}${input.token}${needsTrailingSpace ? " " : ""}${after}`;
}

export function appendMentionTokenToText(currentText: string, token: string): string {
  const trimmedToken = token.trim();
  if (!trimmedToken) return currentText;
  if (currentText.includes(trimmedToken)) {
    return currentText;
  }
  if (!currentText) {
    return `${trimmedToken} `;
  }
  const spacer = /\s$/.test(currentText) ? "" : " ";
  return `${currentText}${spacer}${trimmedToken} `;
}

function resolveHostDisplayLabel(
  serverId: string,
  session: SessionState,
  hostLabelsByServerId?: Readonly<Record<string, string>>,
): string {
  return (
    hostLabelsByServerId?.[serverId]?.trim() || session.serverInfo?.hostname?.trim() || serverId
  );
}

function collectSessionWorkspaces(
  serverId: string,
  hostLabel: string,
  session: SessionState,
  target: MainChatMentionWorkspaceSource[],
): void {
  for (const workspace of session.workspaces.values()) {
    if (workspace.background || workspace.archivingAt) continue;
    if (isMainChatDedicatedWorkspace(workspace, session.agents)) continue;
    target.push({
      serverId,
      hostLabel,
      workspaceId: workspace.id,
      name: workspace.title?.trim() || workspace.name || workspace.projectDisplayName,
      directory: workspace.workspaceDirectory || workspace.projectRootPath,
      projectName: workspace.projectCustomName || workspace.projectDisplayName,
      branch: workspace.gitRuntime?.currentBranch ?? null,
    });
  }
}

function collectSessionRepos(
  serverId: string,
  hostLabel: string,
  session: SessionState,
  target: MainChatMentionRepoSource[],
): void {
  for (const project of session.projects.values()) {
    target.push({
      serverId,
      hostLabel,
      projectId: project.projectId,
      name: project.projectCustomName || project.projectDisplayName,
      rootPath: project.projectRootPath,
    });
  }
}

function collectSessionAgents(
  serverId: string,
  hostLabel: string,
  session: SessionState,
  excludeAgentId: string | undefined,
  target: MainChatMentionSessionSource[],
): void {
  for (const agent of session.agents.values()) {
    if (agent.archivedAt || agent.background || isMainChatAgent(agent)) continue;
    if (excludeAgentId && agent.id === excludeAgentId) continue;
    target.push({
      serverId,
      hostLabel,
      agentId: agent.id,
      title: agent.title?.trim() || agent.id,
      cwd: agent.cwd || null,
      status: agent.status,
    });
  }
}

export function collectMainChatMentionSources(input: {
  sessions: Readonly<Record<string, SessionState>>;
  hostLabelsByServerId?: Readonly<Record<string, string>>;
  excludeAgentId?: string;
}): Omit<MainChatMentionSourceCollection, "skills"> {
  const hosts: MainChatMentionHostSource[] = [];
  const workspaces: MainChatMentionWorkspaceSource[] = [];
  const repos: MainChatMentionRepoSource[] = [];
  const sessions: MainChatMentionSessionSource[] = [];

  for (const [serverId, session] of Object.entries(input.sessions)) {
    const hostLabel = resolveHostDisplayLabel(serverId, session, input.hostLabelsByServerId);
    hosts.push({
      serverId,
      label: hostLabel,
      hostname: session.serverInfo?.hostname ?? null,
      online: Boolean(session.client),
    });
    collectSessionWorkspaces(serverId, hostLabel, session, workspaces);
    collectSessionRepos(serverId, hostLabel, session, repos);
    collectSessionAgents(serverId, hostLabel, session, input.excludeAgentId, sessions);
  }

  return { hosts, workspaces, repos, sessions };
}
