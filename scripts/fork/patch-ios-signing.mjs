#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function escapePbxValue(value) {
  const str = String(value);
  if (/^[A-Za-z0-9._/-]+$/.test(str)) {
    return str;
  }
  return `"${str.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function findMatchingBrace(text, openBraceIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openBraceIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("Unbalanced braces while parsing project.pbxproj.");
}

function findObjectBlockById(pbxproj, objectId) {
  const escapedId = objectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|\\n)(\\s*${escapedId}(?:\\s*/\\*[^*]*\\*/)?\\s*=\\s*\\{)`, "g");
  const match = pattern.exec(pbxproj);
  if (!match) {
    throw new Error(`Could not locate pbxproj object block for ID ${objectId}.`);
  }
  const openBraceIndex = match.index + match[0].length - 1;
  const closeBraceIndex = findMatchingBrace(pbxproj, openBraceIndex);
  return {
    start: openBraceIndex,
    end: closeBraceIndex,
    body: pbxproj.slice(openBraceIndex, closeBraceIndex + 1),
  };
}

function findApplicationTargets(pbxproj) {
  const targets = [];
  const pattern =
    /(?:^|\n)\s*([A-F0-9]{24})\s*(?:\/\*([^*]*)\*\/)?\s*=\s*\{\s*\n\s*isa\s*=\s*PBXNativeTarget;/g;
  let match;
  while ((match = pattern.exec(pbxproj)) !== null) {
    const id = match[1];
    const comment = (match[2] ?? "").trim();
    const openBraceIndex = pbxproj.indexOf("{", match.index);
    const closeBraceIndex = findMatchingBrace(pbxproj, openBraceIndex);
    const body = pbxproj.slice(openBraceIndex, closeBraceIndex + 1);
    const isApplication = /productType\s*=\s*"com\.apple\.product-type\.application";/.test(body);
    if (!isApplication) continue;

    const configListMatch = body.match(/buildConfigurationList\s*=\s*([A-F0-9]{24})/);
    const nameMatch = body.match(/\bname\s*=\s*(?:"([^"]+)"|([^;]+));/);
    if (!configListMatch) continue;
    targets.push({
      id,
      name: (nameMatch?.[1] ?? nameMatch?.[2] ?? comment).trim(),
      buildConfigurationListId: configListMatch[1],
    });
  }
  return targets;
}

function findBuildConfigurations(pbxproj, configListId) {
  const listBlock = findObjectBlockById(pbxproj, configListId);
  const configsMatch = listBlock.body.match(/buildConfigurations\s*=\s*\(([\s\S]*?)\);/);
  if (!configsMatch) {
    throw new Error(`No buildConfigurations array found in XCConfigurationList ${configListId}.`);
  }
  const configs = [];
  const idPattern = /([A-F0-9]{24})\s*(?:\/\*([^*]*)\*\/)?/g;
  let match;
  while ((match = idPattern.exec(configsMatch[1])) !== null) {
    const id = match[1];
    const block = findObjectBlockById(pbxproj, id);
    const nameMatch = block.body.match(/\bname\s*=\s*(?:"([^"]+)"|([^;]+));/);
    const bundleMatch = block.body.match(
      /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*(?:"([^"]+)"|([^;\s]+));/,
    );
    configs.push({
      id,
      name: (nameMatch?.[1] ?? nameMatch?.[2] ?? match[2] ?? "").trim(),
      bundleId: (bundleMatch?.[1] ?? bundleMatch?.[2] ?? "").trim(),
    });
  }
  return configs;
}

function upsertBuildSettings(configBlockBody, updates) {
  const settingsMatch = configBlockBody.match(/buildSettings\s*=\s*\{/);
  if (!settingsMatch || settingsMatch.index === undefined) {
    throw new Error("XCBuildConfiguration block is missing buildSettings.");
  }
  const openIdx = settingsMatch.index + settingsMatch[0].length - 1;
  const closeIdx = findMatchingBrace(configBlockBody, openIdx);
  let settingsBody = configBlockBody.slice(openIdx + 1, closeIdx);

  // Detect indentation used inside buildSettings so patched lines blend cleanly.
  const indentMatch = settingsBody.match(/\n([ \t]+)[A-Za-z0-9_"]/);
  const indent = indentMatch ? indentMatch[1] : "\t\t\t\t";

  for (const [rawKey, rawValue] of Object.entries(updates)) {
    const pbxKey = /^[A-Za-z0-9_]+$/.test(rawKey) ? rawKey : `"${rawKey}"`;
    const pbxVal = escapePbxValue(rawValue);
    const escapedKey = rawKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const entryRe = new RegExp(`(^|\\n)([ \\t]*)(?:"${escapedKey}"|${escapedKey})\\s*=\\s*[^;]*;`);
    if (entryRe.test(settingsBody)) {
      settingsBody = settingsBody.replace(entryRe, `$1$2${pbxKey} = ${pbxVal};`);
    } else {
      const trailingWs = settingsBody.endsWith("\n") ? "" : "\n";
      settingsBody = `${settingsBody}${trailingWs}${indent}${pbxKey} = ${pbxVal};\n`;
    }
  }

  return `${configBlockBody.slice(0, openIdx + 1)}${settingsBody}${configBlockBody.slice(closeIdx)}`;
}

function patchTargetAttributes(pbxproj, targetId, { teamId }) {
  const escapedId = targetId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attrRe = new RegExp(`(${escapedId}\\s*=\\s*\\{)`);
  const targetAttrsIdx = pbxproj.indexOf("TargetAttributes = {");
  if (targetAttrsIdx === -1) return pbxproj;

  const taOpen = pbxproj.indexOf("{", targetAttrsIdx);
  const taClose = findMatchingBrace(pbxproj, taOpen);
  const taSection = pbxproj.slice(taOpen, taClose + 1);
  const match = attrRe.exec(taSection);

  let updatedSection;
  if (match && match.index !== undefined) {
    const entryOpen = taOpen + match.index + match[0].length - 1;
    const entryClose = findMatchingBrace(pbxproj, entryOpen);
    let entryBody = pbxproj.slice(entryOpen, entryClose + 1);

    const setAttr = (key, value) => {
      const keyRe = new RegExp(`(^|\\n)([ \\t]*)${key}\\s*=\\s*[^;]*;`);
      if (keyRe.test(entryBody)) {
        entryBody = entryBody.replace(keyRe, `$1$2${key} = ${value};`);
      } else {
        const lastNewline = entryBody.lastIndexOf("\n");
        const insertAt = lastNewline === -1 ? entryBody.length - 1 : lastNewline + 1;
        entryBody = `${entryBody.slice(0, insertAt)}\t\t\t\t\t\t${key} = ${value};\n${entryBody.slice(insertAt)}`;
      }
    };
    setAttr("ProvisioningStyle", "Manual");
    setAttr("DevelopmentTeam", escapePbxValue(teamId));

    return `${pbxproj.slice(0, entryOpen)}${entryBody}${pbxproj.slice(entryClose + 1)}`;
  }

  const insertion = `\n\t\t\t\t\t${targetId} = {\n\t\t\t\t\t\tDevelopmentTeam = ${escapePbxValue(teamId)};\n\t\t\t\t\t\tProvisioningStyle = Manual;\n\t\t\t\t\t};\n\t\t\t\t`;
  updatedSection = `${taSection.slice(0, -1)}${insertion}}`;
  return `${pbxproj.slice(0, taOpen)}${updatedSection}${pbxproj.slice(taClose + 1)}`;
}

export function patchPbxprojContent(
  pbxproj,
  {
    teamId,
    bundleId,
    profileName,
    profileUuid,
    signingIdentity = "Apple Distribution",
    configuration = "Release",
  },
) {
  if (!teamId || !bundleId || !profileName || !profileUuid) {
    throw new Error("patchPbxprojContent requires teamId, bundleId, profileName, and profileUuid.");
  }

  const appTargets = findApplicationTargets(pbxproj);
  if (appTargets.length === 0) {
    throw new Error("No iOS application PBXNativeTarget found in project.pbxproj.");
  }

  // Prefer target whose build configuration already matches bundleId; otherwise use the first app target.
  let chosenTarget = appTargets[0];
  let chosenConfigs = findBuildConfigurations(pbxproj, chosenTarget.buildConfigurationListId);
  for (const target of appTargets) {
    const configs = findBuildConfigurations(pbxproj, target.buildConfigurationListId);
    if (configs.some((cfg) => cfg.bundleId === bundleId)) {
      chosenTarget = target;
      chosenConfigs = configs;
      break;
    }
  }

  const targetConfig = chosenConfigs.find((cfg) => cfg.name === configuration);
  if (!targetConfig) {
    throw new Error(
      `Target "${chosenTarget.name}" does not have a "${configuration}" build configuration (found: ${chosenConfigs.map((c) => c.name).join(", ")}).`,
    );
  }

  const block = findObjectBlockById(pbxproj, targetConfig.id);
  const patchedBlock = upsertBuildSettings(block.body, {
    CODE_SIGN_STYLE: "Manual",
    DEVELOPMENT_TEAM: teamId,
    CODE_SIGN_IDENTITY: signingIdentity,
    "CODE_SIGN_IDENTITY[sdk=iphoneos*]": signingIdentity,
    PROVISIONING_PROFILE_SPECIFIER: profileName,
    PROVISIONING_PROFILE: profileUuid,
    PRODUCT_BUNDLE_IDENTIFIER: bundleId,
  });

  let updated = `${pbxproj.slice(0, block.start)}${patchedBlock}${pbxproj.slice(block.end + 1)}`;
  updated = patchTargetAttributes(updated, chosenTarget.id, { teamId });

  return {
    content: updated,
    targetName: chosenTarget.name,
    targetId: chosenTarget.id,
    configurationId: targetConfig.id,
  };
}

export function patchIosProjectSigning({
  pbxprojPath,
  teamId,
  bundleId,
  profileName,
  profileUuid,
  signingIdentity = "Apple Distribution",
  configuration = "Release",
}) {
  if (!fs.existsSync(pbxprojPath)) {
    throw new Error(`project.pbxproj not found at ${pbxprojPath}`);
  }
  const original = fs.readFileSync(pbxprojPath, "utf8");
  const result = patchPbxprojContent(original, {
    teamId,
    bundleId,
    profileName,
    profileUuid,
    signingIdentity,
    configuration,
  });
  fs.writeFileSync(pbxprojPath, result.content, "utf8");
  return {
    pbxprojPath,
    targetName: result.targetName,
    targetId: result.targetId,
    configurationId: result.configurationId,
  };
}

function parseCliArgs(argv) {
  const options = {
    pbxprojPath: "",
    teamId: "",
    bundleId: "",
    profileName: "",
    profileUuid: "",
    signingIdentity: "Apple Distribution",
    configuration: "Release",
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pbxproj") {
      options.pbxprojPath = path.resolve(argv[++i] ?? "");
    } else if (arg === "--team-id") {
      options.teamId = argv[++i] ?? "";
    } else if (arg === "--bundle-id") {
      options.bundleId = argv[++i] ?? "";
    } else if (arg === "--profile-name") {
      options.profileName = argv[++i] ?? "";
    } else if (arg === "--profile-uuid") {
      options.profileUuid = argv[++i] ?? "";
    } else if (arg === "--signing-identity") {
      options.signingIdentity = argv[++i] ?? "";
    } else if (arg === "--configuration") {
      options.configuration = argv[++i] ?? "";
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage: node scripts/fork/patch-ios-signing.mjs [options]

Patch manual distribution code-signing settings ONLY onto the main iOS
application target in project.pbxproj, leaving CocoaPods resource bundle
targets untouched so xcodebuild archive does not fail with provisioning errors.

Options:
  --pbxproj <path>             Path to <App>.xcodeproj/project.pbxproj
  --team-id <id>               10-char Apple Developer Team ID
  --bundle-id <id>             Target iOS Bundle ID
  --profile-name <name>        Provisioning profile Name
  --profile-uuid <uuid>        Provisioning profile UUID
  --signing-identity <name>    Default: "Apple Distribution"
  --configuration <name>       Default: "Release"
  -h, --help                   Show this help message`);
    return;
  }

  const result = patchIosProjectSigning(options);
  console.log(
    `Patched manual signing on target "${result.targetName}" (${options.configuration}) in ${result.pbxprojPath}`,
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
