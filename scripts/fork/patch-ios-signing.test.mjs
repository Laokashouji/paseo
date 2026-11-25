import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { patchPbxprojContent } from "./patch-ios-signing.mjs";

const SAMPLE_PBXPROJ = `// !$*UTF8*$!
{
	archiveVersion = 1;
	objects = {
		13B07F861A680F5B00A75B9A /* PaseoFork */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = 13B07F931A680F5B00A75B9A /* Build configuration list for PBXNativeTarget "PaseoFork" */;
			name = PaseoFork;
			productType = "com.apple.product-type.application";
		};
		222222222222222222222222 /* HelperExtension */ = {
			isa = PBXNativeTarget;
			buildConfigurationList = 333333333333333333333333 /* Build configuration list for PBXNativeTarget "HelperExtension" */;
			name = HelperExtension;
			productType = "com.apple.product-type.bundle";
		};
		83CBB9F71A601CBA00E9B192 /* Project object */ = {
			isa = PBXProject;
			attributes = {
				TargetAttributes = {
					13B07F861A680F5B00A75B9A = {
						LastSwiftMigration = 1250;
					};
				};
			};
		};
		13B07F931A680F5B00A75B9A /* Build configuration list for PBXNativeTarget "PaseoFork" */ = {
			isa = XCConfigurationList;
			buildConfigurations = (
				13B07F941A680F5B00A75B9A /* Debug */,
				13B07F951A680F5B00A75B9A /* Release */,
			);
			defaultConfigurationName = Release;
		};
		13B07F941A680F5B00A75B9A /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CODE_SIGN_STYLE = Automatic;
				PRODUCT_BUNDLE_IDENTIFIER = com.laokashouji.paseo;
			};
			name = Debug;
		};
		13B07F951A680F5B00A75B9A /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;
				CODE_SIGN_IDENTITY = "iPhone Developer";
				PRODUCT_BUNDLE_IDENTIFIER = com.laokashouji.paseo;
			};
			name = Release;
		};
	};
}
`;

describe("patch-ios-signing.mjs", () => {
  it("patches only the main application target Release configuration and TargetAttributes", () => {
    const result = patchPbxprojContent(SAMPLE_PBXPROJ, {
      teamId: "ABCDE12345",
      bundleId: "com.laokashouji.paseo",
      profileName: "Paseo Fork AppStore",
      profileUuid: "11111111-2222-3333-4444-555555555555",
    });

    assert.equal(result.targetName, "PaseoFork");
    assert.equal(result.configurationId, "13B07F951A680F5B00A75B9A");

    // Release configuration has manual distribution signing settings.
    const releaseSection = result.content.slice(
      result.content.indexOf("13B07F951A680F5B00A75B9A /* Release */ = {"),
    );
    assert.match(releaseSection, /CODE_SIGN_STYLE = Manual;/);
    assert.match(releaseSection, /DEVELOPMENT_TEAM = ABCDE12345;/);
    assert.match(releaseSection, /CODE_SIGN_IDENTITY = "Apple Distribution";/);
    assert.match(releaseSection, /"CODE_SIGN_IDENTITY\[sdk=iphoneos\*\]" = "Apple Distribution";/);
    assert.match(releaseSection, /PROVISIONING_PROFILE_SPECIFIER = "Paseo Fork AppStore";/);
    assert.match(releaseSection, /PROVISIONING_PROFILE = 11111111-2222-3333-4444-555555555555;/);

    // Debug configuration stays untouched (still Automatic, no provisioning profile).
    const debugSection = result.content.slice(
      result.content.indexOf("13B07F941A680F5B00A75B9A /* Debug */ = {"),
      result.content.indexOf("13B07F951A680F5B00A75B9A /* Release */ = {"),
    );
    assert.match(debugSection, /CODE_SIGN_STYLE = Automatic;/);
    assert.doesNotMatch(debugSection, /PROVISIONING_PROFILE_SPECIFIER/);

    // TargetAttributes updated with Manual + DevelopmentTeam.
    assert.match(result.content, /ProvisioningStyle = Manual;/);
    assert.match(result.content, /DevelopmentTeam = ABCDE12345;/);
  });
});
