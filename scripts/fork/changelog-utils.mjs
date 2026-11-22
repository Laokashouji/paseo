import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_HEADING_RE = /^ {0,3}##(?:[ \t]+(.*?))?[ \t]*$/;
const SECTION_HEADING_RE = /^ {0,3}###(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/;
const ATX_CLOSING_RE = /[ \t]+#+[ \t]*$/;
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const DASH_SEPARATED_DATE_RE = /^(.*?)\s+[-–—]\s+(.+)$/;
const PARENTHESIZED_DATE_RE = /^(.*?)\s*\((.+)\)$/;
const BRACKETED_VERSION_RE = /^\[(.*)\]$/;
const LEADING_VERSION_PREFIX_RE = /^(?:fork-)?v(?=\d)/i;
const MERGE_COMMIT_RE = /^(?:merge(?:\([^)]*\))?:|Merge\b)/;

function trimBlankLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim().length === 0) start += 1;
  while (end > start && lines[end - 1].trim().length === 0) end -= 1;
  return lines.slice(start, end);
}

export function normalizeForkVersion(raw) {
  const unbracketed = String(raw ?? "")
    .trim()
    .replace(BRACKETED_VERSION_RE, "$1")
    .trim();
  return unbracketed.replace(LEADING_VERSION_PREFIX_RE, "");
}

function splitReleaseHeading(heading) {
  const plain = heading.replace(ATX_CLOSING_RE, "").replace(MARKDOWN_LINK_RE, "$1").trim();

  const dashed = plain.match(DASH_SEPARATED_DATE_RE);
  if (dashed) {
    return { version: normalizeForkVersion(dashed[1]), date: dashed[2].trim() };
  }

  const parenthesized = plain.match(PARENTHESIZED_DATE_RE);
  if (parenthesized) {
    return { version: normalizeForkVersion(parenthesized[1]), date: parenthesized[2].trim() };
  }

  return { version: normalizeForkVersion(plain), date: "" };
}

function markFencedLines(lines) {
  let fence = null;
  return lines.map((line) => {
    const edge = line.match(FENCE_OPEN_RE)?.[1];
    if (!edge) {
      return fence !== null;
    }
    if (fence === null) {
      fence = edge;
    } else if (edge[0] === fence[0] && edge.length >= fence.length) {
      fence = null;
    }
    return true;
  });
}

function splitHighlightsAndSections(bodyLines) {
  const fenced = markFencedLines(bodyLines);
  const firstSectionIndex = bodyLines.findIndex(
    (line, index) => !fenced[index] && SECTION_HEADING_RE.test(line),
  );
  const splitIndex = firstSectionIndex === -1 ? bodyLines.length : firstSectionIndex;
  return {
    highlightLines: trimBlankLines(bodyLines.slice(0, splitIndex)),
    sectionLines: trimBlankLines(bodyLines.slice(splitIndex)),
  };
}

export function parseForkChangelog(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const fenced = markFencedLines(lines);
  const headings = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (fenced[index]) continue;
    const match = lines[index].match(RELEASE_HEADING_RE);
    if (!match) continue;
    const { version, date } = splitReleaseHeading(match[1] ?? "");
    if (!version) continue;
    headings.push({ version, date, headingLineIndex: index });
  }

  return headings.map((heading, index) => {
    const nextHeading = headings[index + 1];
    const start = heading.headingLineIndex + 1;
    const end = nextHeading ? nextHeading.headingLineIndex : lines.length;
    const bodyLines = trimBlankLines(lines.slice(start, end));
    const { highlightLines, sectionLines } = splitHighlightsAndSections(bodyLines);
    return {
      version: heading.version,
      date: heading.date,
      bodyLines,
      highlightLines,
      sectionLines,
    };
  });
}

export function findForkChangelogEntry(markdown, version) {
  const target = normalizeForkVersion(version);
  if (!target) return null;
  return parseForkChangelog(markdown).find((entry) => entry.version === target) ?? null;
}

export function filterChangelogCommits(commits) {
  const seen = new Set();
  const filtered = [];
  for (const raw of commits ?? []) {
    const subject = String(raw ?? "").trim();
    if (!subject) continue;
    if (MERGE_COMMIT_RE.test(subject)) continue;
    if (seen.has(subject)) continue;
    seen.add(subject);
    filtered.push(subject);
  }
  return filtered;
}

export function formatDraftEntry({ version, date, commits = [] }) {
  const normalizedVersion = normalizeForkVersion(version);
  const resolvedDate = String(date ?? "").trim() || new Date().toISOString().slice(0, 10);
  const items = filterChangelogCommits(commits);
  const lines = [`## ${normalizedVersion} - ${resolvedDate}`, ""];
  if (items.length > 0) {
    for (const item of items) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push("- （补充本次更新说明）");
  }
  return `${lines.join("\n")}\n`;
}

export function buildReleaseBody({
  version,
  upstreamBaseVersion,
  commitSha,
  repo,
  entry = null,
  fallbackCommits = [],
}) {
  const normalizedVersion = normalizeForkVersion(version);
  const parts = [];

  if (entry && entry.bodyLines.length > 0) {
    const heading = entry.date ? `## ${entry.version} - ${entry.date}` : `## ${entry.version}`;
    parts.push(heading);
    if (entry.highlightLines.length > 0 && entry.sectionLines.length > 0) {
      parts.push(
        "",
        ...entry.highlightLines,
        "",
        "<details>",
        "<summary>全部变更</summary>",
        "",
        ...entry.sectionLines,
        "",
        "</details>",
      );
    } else {
      parts.push("", ...entry.bodyLines);
    }
  } else {
    const items = filterChangelogCommits(fallbackCommits);
    parts.push(`Paseo Fork desktop build \`${normalizedVersion}\``);
    if (items.length > 0) {
      parts.push("", "### Changes", "");
      for (const item of items) {
        parts.push(`- ${item}`);
      }
    }
  }

  const meta = [];
  if (upstreamBaseVersion) meta.push(`- Upstream package base: \`${upstreamBaseVersion}\``);
  if (commitSha) meta.push(`- Built commit: \`${commitSha}\``);
  if (repo) meta.push(`- Auto-update repository: \`${repo}\``);

  if (meta.length > 0) {
    parts.push("", "---", "", ...meta);
  }

  return `${parts.join("\n").trim()}\n`;
}

function readOptionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function readStdinText() {
  return fs.readFileSync(0, "utf8");
}

function readFileIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function runCheck(argv) {
  let filePath = "FORK_CHANGELOG.md";
  let version = "";
  let useStdin = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      filePath = readOptionValue(argv, index, "--file");
      index += 1;
    } else if (arg === "--version") {
      version = readOptionValue(argv, index, "--version");
      index += 1;
    } else if (arg === "--stdin") {
      useStdin = true;
    } else {
      throw new Error(`Unknown check option: ${arg}`);
    }
  }

  if (!version) {
    throw new Error("--version is required");
  }

  const markdown = useStdin ? readStdinText() : readFileIfExists(filePath);
  const entry = findForkChangelogEntry(markdown, version);
  const result = {
    found: entry !== null,
    version: normalizeForkVersion(version),
    entry,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!entry) {
    process.exitCode = 1;
  }
}

function runDraft(argv) {
  let version = "";
  let date = "";
  let commitsFromStdin = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      version = readOptionValue(argv, index, "--version");
      index += 1;
    } else if (arg === "--date") {
      date = readOptionValue(argv, index, "--date");
      index += 1;
    } else if (arg === "--commits-stdin") {
      commitsFromStdin = true;
    } else {
      throw new Error(`Unknown draft option: ${arg}`);
    }
  }

  if (!version) {
    throw new Error("--version is required");
  }

  const commits = commitsFromStdin ? readStdinText().split(/\r?\n/) : [];
  process.stdout.write(formatDraftEntry({ version, date, commits }));
}

function runReleaseNotes(argv) {
  let filePath = "FORK_CHANGELOG.md";
  let version = "";
  let upstreamBaseVersion = "";
  let commitSha = "";
  let repo = "";
  let commitsFromStdin = false;
  let outputPath = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      filePath = readOptionValue(argv, index, "--file");
      index += 1;
    } else if (arg === "--version") {
      version = readOptionValue(argv, index, "--version");
      index += 1;
    } else if (arg === "--upstream-version") {
      upstreamBaseVersion = readOptionValue(argv, index, "--upstream-version");
      index += 1;
    } else if (arg === "--commit") {
      commitSha = readOptionValue(argv, index, "--commit");
      index += 1;
    } else if (arg === "--repo") {
      repo = readOptionValue(argv, index, "--repo");
      index += 1;
    } else if (arg === "--commits-stdin") {
      commitsFromStdin = true;
    } else if (arg === "--output") {
      outputPath = readOptionValue(argv, index, "--output");
      index += 1;
    } else {
      throw new Error(`Unknown release-notes option: ${arg}`);
    }
  }

  if (!version) {
    throw new Error("--version is required");
  }

  const markdown = readFileIfExists(filePath);
  const entry = findForkChangelogEntry(markdown, version);
  const fallbackCommits = commitsFromStdin ? readStdinText().split(/\r?\n/) : [];
  const body = buildReleaseBody({
    version,
    upstreamBaseVersion,
    commitSha,
    repo,
    entry,
    fallbackCommits,
  });

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, body, "utf8");
  } else {
    process.stdout.write(body);
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "check") {
    runCheck(rest);
  } else if (command === "draft") {
    runDraft(rest);
  } else if (command === "release-notes") {
    runReleaseNotes(rest);
  } else {
    process.stderr.write(
      "Usage: node scripts/fork/changelog-utils.mjs <check|draft|release-notes> [options]\n",
    );
    process.exit(2);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
