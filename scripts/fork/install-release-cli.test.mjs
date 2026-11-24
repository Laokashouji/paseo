import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALL_SCRIPT = path.join(REPO_ROOT, "scripts/fork/install-release-cli.sh");

function createCleanPath(tempRoot) {
  // Expose only the host's `node` binary so any npm-global `paseo` next to `node` never leaks in.
  const shimBin = path.join(tempRoot, "clean-node-bin");
  fs.mkdirSync(shimBin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(shimBin, "node"));
  return `${shimBin}:/usr/bin:/bin`;
}

function createMinimalDaemonTarball(tempRoot, version = "0.17.519") {
  const srcDir = path.join(tempRoot, `payload-${version}`);
  fs.mkdirSync(path.join(srcDir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(srcDir, "node_modules/@getpaseo/server"), { recursive: true });

  fs.writeFileSync(
    path.join(srcDir, "fork-runtime.json"),
    JSON.stringify({
      schemaVersion: 1,
      repo: "Laokashouji/paseo",
      version,
      tag: `fork-v${version}`,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  fs.writeFileSync(
    path.join(srcDir, "node_modules/@getpaseo/server/package.json"),
    JSON.stringify({ name: "@getpaseo/server", version }),
  );
  fs.writeFileSync(path.join(srcDir, "bin/paseo"), `#!/usr/bin/env bash\necho "${version}"\n`, {
    mode: 0o755,
  });

  const tarballPath = path.join(tempRoot, `paseo-daemon-${version}.tar.gz`);
  const tarResult = spawnSync("tar", ["-czf", tarballPath, "-C", srcDir, "."], {
    encoding: "utf8",
  });
  assert.equal(tarResult.status, 0, `tar failed: ${tarResult.stderr}`);
  return tarballPath;
}

function runInstaller(args, { homeDir, pathValue }) {
  return spawnSync("bash", [INSTALL_SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      HOME: homeDir,
      PATH: pathValue,
    },
  });
}

describe("install-release-cli.sh", () => {
  it("auto-links ~/.local/bin/paseo and prints a PATH hint on a fresh machine", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-install-fresh-"));
    try {
      const homeDir = path.join(tempRoot, "home");
      fs.mkdirSync(homeDir, { recursive: true });
      const tarball = createMinimalDaemonTarball(tempRoot, "0.17.519");

      const res = runInstaller(["--from-tarball", tarball], {
        homeDir,
        pathValue: createCleanPath(tempRoot),
      });

      assert.equal(res.status, 0, `stderr: ${res.stderr}\nstdout: ${res.stdout}`);
      const defaultBin = path.join(homeDir, ".local/bin/paseo");
      const forkWrapper = path.join(homeDir, ".local/bin/paseo-fork");
      assert.equal(fs.lstatSync(defaultBin).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(defaultBin), forkWrapper);
      assert.match(res.stdout, /Created default CLI symlink/);
      assert.match(res.stdout, /Run 'paseo' to start the daemon/);
      assert.doesNotMatch(res.stdout, /systemctl --user restart/);
      assert.match(res.stdout, /is not in your PATH/);
      assert.match(res.stdout, /export PATH="\$HOME\/\.local\/bin:\$PATH"/);

      const versionRes = spawnSync(defaultBin, ["--version"], { encoding: "utf8" });
      assert.equal(versionRes.status, 0);
      assert.equal(versionRes.stdout.trim(), "0.17.519");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("leaves an existing paseo untouched unless --switch-default is passed, and supports restore", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-install-migrate-"));
    try {
      const homeDir = path.join(tempRoot, "home");
      const localBinDir = path.join(homeDir, ".local/bin");
      const officialDir = path.join(tempRoot, "official");
      fs.mkdirSync(localBinDir, { recursive: true });
      fs.mkdirSync(officialDir, { recursive: true });

      const officialTarget = path.join(officialDir, "paseo-official");
      fs.writeFileSync(officialTarget, '#!/usr/bin/env bash\necho "0.16.2"\n', { mode: 0o755 });
      const defaultBin = path.join(localBinDir, "paseo");
      fs.symlinkSync(officialTarget, defaultBin);

      const tarball = createMinimalDaemonTarball(tempRoot, "0.17.519");
      const pathWithLocalBin = `${localBinDir}:${createCleanPath(tempRoot)}`;

      const safeRes = runInstaller(["--from-tarball", tarball], {
        homeDir,
        pathValue: pathWithLocalBin,
      });
      assert.equal(safeRes.status, 0, `stderr: ${safeRes.stderr}`);
      assert.equal(fs.readlinkSync(defaultBin), officialTarget);
      assert.match(safeRes.stdout, /existing paseo found/);
      assert.match(safeRes.stdout, /re-run with --switch-default/);
      assert.doesNotMatch(safeRes.stdout, /is not in your PATH/);

      const switchRes = runInstaller(["--from-tarball", tarball, "--switch-default"], {
        homeDir,
        pathValue: pathWithLocalBin,
      });
      assert.equal(switchRes.status, 0, `stderr: ${switchRes.stderr}`);
      assert.equal(fs.readlinkSync(defaultBin), path.join(localBinDir, "paseo-fork"));
      assert.match(switchRes.stdout, /Saved original paseo target/);
      assert.match(switchRes.stdout, /systemctl --user restart paseo-daemon\.service/);

      const restoreRes = runInstaller(["--restore-official"], {
        homeDir,
        pathValue: pathWithLocalBin,
      });
      assert.equal(restoreRes.status, 0, `stderr: ${restoreRes.stderr}`);
      assert.equal(fs.readlinkSync(defaultBin), officialTarget);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("detects a global npm paseo elsewhere in PATH and prompts before shadowing", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-install-global-"));
    try {
      const homeDir = path.join(tempRoot, "home");
      const globalBin = path.join(tempRoot, "global-bin");
      fs.mkdirSync(homeDir, { recursive: true });
      fs.mkdirSync(globalBin, { recursive: true });
      fs.writeFileSync(path.join(globalBin, "paseo"), '#!/usr/bin/env bash\necho "0.16.2"\n', {
        mode: 0o755,
      });

      const tarball = createMinimalDaemonTarball(tempRoot, "0.17.519");
      const pathValue = `${path.join(homeDir, ".local/bin")}:${globalBin}:${createCleanPath(tempRoot)}`;

      const res = runInstaller(["--from-tarball", tarball], { homeDir, pathValue });
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      assert.equal(fs.existsSync(path.join(homeDir, ".local/bin/paseo")), false);
      assert.match(res.stdout, /existing paseo found/);

      const switchRes = runInstaller(["--from-tarball", tarball, "--switch-default"], {
        homeDir,
        pathValue,
      });
      assert.equal(switchRes.status, 0, `stderr: ${switchRes.stderr}`);
      assert.equal(fs.lstatSync(path.join(homeDir, ".local/bin/paseo")).isSymbolicLink(), true);
      assert.match(switchRes.stdout, /systemctl --user restart paseo-daemon\.service/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("respects --no-switch-default on a fresh machine", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-install-noswitch-"));
    try {
      const homeDir = path.join(tempRoot, "home");
      fs.mkdirSync(homeDir, { recursive: true });
      const tarball = createMinimalDaemonTarball(tempRoot, "0.17.519");

      const res = runInstaller(["--from-tarball", tarball, "--no-switch-default"], {
        homeDir,
        pathValue: `${path.join(homeDir, ".local/bin")}:${createCleanPath(tempRoot)}`,
      });
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      assert.equal(fs.existsSync(path.join(homeDir, ".local/bin/paseo-fork")), true);
      assert.equal(fs.existsSync(path.join(homeDir, ".local/bin/paseo")), false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
