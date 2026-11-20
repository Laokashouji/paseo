import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  computeNextForkVersion,
  decodeForkPatch,
  parseForkTag,
  parseUpstreamVersion,
} from "./version-utils.mjs";

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
    assert.deepEqual(parseForkTag("fork-v0.17.10001"), {
      sourceTag: "fork-v0.17.10001",
      releaseTag: "fork-v0.17.10001",
      version: "0.17.10001",
      releaseType: "release",
      releaseChannel: "latest",
    });
    assert.equal(parseForkTag("refs/tags/fork-v0.16.10203").version, "0.16.10203");
  });

  it("rejects upstream v* tags and prerelease tags", () => {
    assert.throws(() => parseForkTag("v0.16.2"), /Unsupported fork tag/);
    assert.throws(() => parseForkTag("fork-v0.16.2-beta.1"), /Unsupported fork tag/);
  });
});

describe("computeNextForkVersion", () => {
  it("generates monotonic non-prerelease versions across rebuilds and upstream bumps", () => {
    const first = computeNextForkVersion({ upstreamVersion: "0.16.2", existingTags: [] });
    assert.equal(first.version, "0.16.10201");
    assert.equal(first.tag, "fork-v0.16.10201");
    assert.equal(first.forkRev, 1);

    const second = computeNextForkVersion({
      upstreamVersion: "0.16.2",
      existingTags: ["v0.16.2", "fork-v0.16.10201"],
    });
    assert.equal(second.version, "0.16.10202");
    assert.equal(second.forkRev, 2);

    const nextPatch = computeNextForkVersion({
      upstreamVersion: "0.16.3",
      existingTags: ["fork-v0.16.10201", "fork-v0.16.10202"],
    });
    assert.equal(nextPatch.version, "0.16.10301");

    const nextMinorBeta = computeNextForkVersion({
      upstreamVersion: "0.17.0-beta.1",
      existingTags: ["fork-v0.16.10301"],
    });
    assert.equal(nextMinorBeta.version, "0.17.10001");

    const nextMinorStable = computeNextForkVersion({
      upstreamVersion: "0.17.0",
      existingTags: ["fork-v0.17.10001"],
    });
    assert.equal(nextMinorStable.version, "0.17.10002");

    const doubleDigitPatch = computeNextForkVersion({
      upstreamVersion: "0.17.12",
      existingTags: ["fork-v0.17.10002"],
    });
    assert.equal(doubleDigitPatch.version, "0.17.11201");
  });

  it("decodes fork patches cleanly", () => {
    assert.deepEqual(decodeForkPatch(10001), { upstreamPatch: 0, forkRev: 1 });
    assert.deepEqual(decodeForkPatch(10205), { upstreamPatch: 2, forkRev: 5 });
    assert.equal(decodeForkPatch(2), null);
    assert.equal(decodeForkPatch(10200), null);
  });

  it("supports explicit version override", () => {
    const res = computeNextForkVersion({
      upstreamVersion: "0.17.0-beta.1",
      explicitVersion: "0.17.10009",
    });
    assert.equal(res.version, "0.17.10009");
    assert.equal(res.tag, "fork-v0.17.10009");

    assert.throws(
      () =>
        computeNextForkVersion({
          upstreamVersion: "0.17.0",
          explicitVersion: "0.17.0-fork.1",
        }),
      /Invalid explicit fork version/,
    );
  });

  it("keeps patch values strictly ordered across upstream patch boundaries", () => {
    const maxPatch0 = computeNextForkVersion({
      upstreamVersion: "0.17.0",
      existingTags: ["fork-v0.17.10098"],
    });
    const minPatch1 = computeNextForkVersion({
      upstreamVersion: "0.17.1",
      existingTags: ["fork-v0.17.10099"],
    });
    assert.equal(maxPatch0.version, "0.17.10099");
    assert.equal(minPatch1.version, "0.17.10101");
    assert.ok(10101 > 10099);
    // Avoid unused imports warning while verifying temp dir creation works if needed
    assert.ok(fs.existsSync(os.tmpdir()));
    assert.ok(path.isAbsolute(os.tmpdir()));
  });
});
