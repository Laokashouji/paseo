import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildReleaseBody,
  filterChangelogCommits,
  findForkChangelogEntry,
  formatDraftEntry,
  parseForkChangelog,
} from "./changelog-utils.mjs";

describe("parseForkChangelog", () => {
  it("parses release entries, highlights, and sections while ignoring fenced headings", () => {
    const markdown = [
      "# Fork Changelog",
      "",
      "## 0.17.505 - 2026-11-22",
      "",
      "- **更新公告双源混排**：支持同时展示 Fork 与上游更新记录。",
      "",
      "```markdown",
      "## 9.9.9 - 2099-01-01",
      "```",
      "",
      "### Fixed",
      "",
      "- 修复工作台摘要校验",
      "",
      "## 0.17.504 - 2026-11-22",
      "",
      "- 修复打包版插件编译依赖",
      "",
    ].join("\n");

    const entries = parseForkChangelog(markdown);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      version: "0.17.505",
      date: "2026-11-22",
      bodyLines: [
        "- **更新公告双源混排**：支持同时展示 Fork 与上游更新记录。",
        "",
        "```markdown",
        "## 9.9.9 - 2099-01-01",
        "```",
        "",
        "### Fixed",
        "",
        "- 修复工作台摘要校验",
      ],
      highlightLines: [
        "- **更新公告双源混排**：支持同时展示 Fork 与上游更新记录。",
        "",
        "```markdown",
        "## 9.9.9 - 2099-01-01",
        "```",
      ],
      sectionLines: ["### Fixed", "", "- 修复工作台摘要校验"],
    });
    assert.equal(entries[1].version, "0.17.504");
  });
});

describe("findForkChangelogEntry", () => {
  it("matches normalized versions with or without fork-v / v prefixes", () => {
    const markdown = "## 0.17.504 - 2026-11-22\n\n- Fix plugin build\n";
    assert.equal(findForkChangelogEntry(markdown, "0.17.504")?.version, "0.17.504");
    assert.equal(findForkChangelogEntry(markdown, "v0.17.504")?.version, "0.17.504");
    assert.equal(findForkChangelogEntry(markdown, "fork-v0.17.504")?.version, "0.17.504");
    assert.equal(findForkChangelogEntry(markdown, "0.17.505"), null);
  });
});

describe("filterChangelogCommits and formatDraftEntry", () => {
  it("filters merge commits and duplicates when building a draft entry", () => {
    const filtered = filterChangelogCommits([
      "merge(fork): 集成多个特性",
      "Merge branch 'main'",
      "feat(fork): 新增功能 A",
      "feat(fork): 新增功能 A",
      "",
      "fix(fork): 修复问题 B",
    ]);
    assert.deepEqual(filtered, ["feat(fork): 新增功能 A", "fix(fork): 修复问题 B"]);

    const draft = formatDraftEntry({
      version: "fork-v0.17.505",
      date: "2026-11-22",
      commits: filtered,
    });
    assert.equal(
      draft,
      "## 0.17.505 - 2026-11-22\n\n- feat(fork): 新增功能 A\n- fix(fork): 修复问题 B\n",
    );
  });
});

describe("buildReleaseBody", () => {
  it("renders structured changelog entry with collapsible sections and build metadata", () => {
    const markdown = [
      "## 0.17.505 - 2026-11-22",
      "",
      "- **亮点 A**：说明内容。",
      "",
      "### Fixed",
      "",
      "- 修复细节 B",
    ].join("\n");
    const entry = findForkChangelogEntry(markdown, "0.17.505");
    const body = buildReleaseBody({
      version: "0.17.505",
      upstreamBaseVersion: "0.17.0-beta.1",
      commitSha: "abc1234",
      repo: "Laokashouji/paseo",
      entry,
    });

    assert.match(body, /^## 0\.17\.505 - 2026-11-22/);
    assert.match(body, /- \*\*亮点 A\*\*：说明内容。/);
    assert.match(body, /<details>\n<summary>全部变更<\/summary>/);
    assert.match(body, /### Fixed\n\n- 修复细节 B/);
    assert.match(body, /Upstream package base: `0\.17\.0-beta\.1`/);
    assert.match(body, /Built commit: `abc1234`/);
    assert.match(body, /Auto-update repository: `Laokashouji\/paseo`/);
  });

  it("falls back to filtered commit list when no changelog entry matches", () => {
    const body = buildReleaseBody({
      version: "0.17.505",
      upstreamBaseVersion: "0.17.0-beta.1",
      commitSha: "abc1234",
      repo: "Laokashouji/paseo",
      entry: null,
      fallbackCommits: ["merge(fork): 忽略合并提交", "fix(fork): 修复某问题"],
    });

    assert.match(body, /Paseo Fork desktop build `0\.17\.505`/);
    assert.match(body, /### Changes\n\n- fix\(fork\): 修复某问题/);
    assert.doesNotMatch(body, /忽略合并提交/);
  });
});
