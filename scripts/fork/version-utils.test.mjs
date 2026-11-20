import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import {
  computeNextForkVersion,
  parseForkTag,
  parseUpstreamVersion,
} from "./version-utils.mjs";

const require = createRequire(import.meta.url);
const { getNativeReleaseVersion } = require("../../packages/app/native-release-version.js");

describe("parseUpstreamVersion", () => {
  it("parses stable and beta upstream versions", () => {
    assert.deepEqual(parseUpstreamVersion("0.16.2"), {
      version: "0.16.2",
      major: 0,
      minor: 16,
      patch: 2,
      prerelease: null,
      baseVersion: "0.16.2",
    });

    assert.deepEqual(parseUpstreamVersion("0.17.0-beta.1"), {
      version: "0.17.0-beta.1",
      major: 0,
      minor: 17,
      patch: 0,
      prerelease: "beta.1",
      baseVersion: "0.17.0",
    });
  });

  it("rejects invalid version strings", () => {
    assert.throws(() => parseUpstreamVersion("not-a-version"), /Unsupported upstream version/);
  });
});

describe("parseForkTag", () => {
  it("parses fork-v tags and full refs/tags/ paths", () => {
    assert.deepEqual(parseForkTag("fork-v0.17.501"), {
      sourceTag: "fork-v0.17.501",
      releaseTag: "fork-v0.17.501",
      version: "0.17.501",
      releaseType: "release",
      releaseChannel: "latest",
    });
    assert.equal(parseForkTag("refs/tags/fork-v0.16.503").version, "0.16.503");
  });

  it("rejects upstream v* tags, prerelease tags, and out-of-range patches", () => {
    assert.throws(() => parseForkTag("v0.16.2"), /Unsupported fork tag/);
    assert.throws(() => parseForkTag("fork-v0.16.2-beta.1"), /Unsupported fork tag/);
    assert.throws(() => parseForkTag("fork-v0.17.1000"), /must be <= 999/);
  });
});

describe("computeNextForkVersion", () => {
  it("generates monotonic non-prerelease versions compatible with Expo native-release-version", () => {
    const first = computeNextForkVersion({ upstreamVersion: "0.16.2", existingTags: [] });
    assert.equal(first.version, "0.16.501");
    assert.equal(first.tag, "fork-v0.16.501");
    assert.equal(first.forkRev, 1);

    const second = computeNextForkVersion({
      upstreamVersion: "0.16.2",
      existingTags: ["v0.16.2", "fork-v0.16.501"],
    });
    assert.equal(second.version, "0.16.502");
    assert.equal(second.forkRev, 2);

    const nextPatch = computeNextForkVersion({
      upstreamVersion: "0.16.3",
      existingTags: ["fork-v0.16.501", "fork-v0.16.502"],
    });
    assert.equal(nextPatch.version, "0.16.503");

    const nextMinorBeta = computeNextForkVersion({
      upstreamVersion: "0.17.0-beta.1",
      existingTags: ["fork-v0.16.503"],
    });
    assert.equal(nextMinorBeta.version, "0.17.501");

    const nextMinorStable = computeNextForkVersion({
      upstreamVersion: "0.17.0",
      existingTags: ["fork-v0.17.501"],
    });
    assert.equal(nextMinorStable.version, "0.17.502");

    const ignoresLegacyOutOfRangeTag = computeNextForkVersion({
      upstreamVersion: "0.17.0-beta.1",
      existingTags: ["fork-v0.17.10001"],
    });
    assert.equal(ignoresLegacyOutOfRangeTag.version, "0.17.501");

    for (const candidate of [first, second, nextPatch, nextMinorBeta, nextMinorStable]) {
      const native = getNativeReleaseVersion(candidate.version);
      assert.equal(native.appVersion, candidate.version);
    }
  });

  it("supports explicit version override and enforces <= 999 bound", () => {
    const res = computeNextForkVersion({
      upstreamVersion: "0.17.0-beta.1",
      explicitVersion: "0.17.509",
    });
    assert.equal(res.version, "0.17.509");
    assert.equal(res.tag, "fork-v0.17.509");

    assert.throws(
      () =>
        computeNextForkVersion({
          upstreamVersion: "0.17.0",
          explicitVersion: "0.17.0-fork.1",
        }),
      /Invalid explicit fork version/,
    );

    assert.throws(
      () =>
        computeNextForkVersion({
          upstreamVersion: "0.17.0",
          explicitVersion: "0.17.10001",
        }),
      /must be <= 999/,
    );
  });

  it("throws when fork patch overflows 999", () => {
    assert.throws(
      () =>
        computeNextForkVersion({
          upstreamVersion: "0.17.0",
          existingTags: ["fork-v0.17.999"],
        }),
      /Fork patch overflow/,
    );
  });
});
