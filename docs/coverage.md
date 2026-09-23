# Coverage

Source baseline: eas-cli 24.7.0 (299 interactive prompt call sites found in `build/`),
@expo/agent-cli 1.0.16, eas-autopilot 1.0.0 with the `eas-ios-adhoc` Flow. Checked 2026-09-23.

Legend: ✅ answered automatically · 🙋 handed to the human on purpose · ❌ not handled (in `run`
mode it reaches the human as an unknown prompt; teach it with `record` → `learn` → `check`) ·
— not applicable.

## iOS internal (ad hoc) build: `eas build --platform ios --profile preview`

| # | Scenario (eas-cli prompt) | eas-cli source | eas-autopilot | @expo/agent-cli |
| --- | --- | --- | --- | --- |
| 1 | Working tree dirty: "Commit changes to git?" | `build/utils/repository.js` | ✅ checked before EAS starts; whitespace-only changes restored, real changes stop the run | — |
| 2 | "Do you want to log in to your Apple account?" | `credentials/context.js` | ✅ yes | — |
| 3 | "Apple ID:" (saved address prefilled) | `credentials/ios/appstore/resolveCredentials.js` | 🙋 menu: use it, trust it for 3 days, or type another | — |
| 4 | Apple password, 2FA code | `credentials/ios/appstore/` | 🙋 answered in EAS's own prompt; never recorded | — |
| 5 | "Select your Apple Team Type:", Apple Team ID, provider | `credentials/ios/appstore/resolveCredentials.js` | ❌ | — |
| 6 | "Reuse this distribution certificate?" / select or revoke certificates | `credentials/ios/actions/SetUpDistributionCertificate.js` | ❌ | — |
| 7 | "Would you like to set up Push Notifications for your project?" / reuse or select push key | `credentials/ios/IosCredentialsProvider.js`, `SetUpPushKey.js` | ❌ | — |
| 8 | "You don't have any registered devices yet. Would you like to register them now?" | `SetUpAdhocProvisioningProfile.js` | ❌ | — |
| 9 | Profile is missing devices: "Would you like to choose the devices to provision again?" | `SetUpAdhocProvisioningProfile.js` | ✅ yes | — |
| 10 | "Select devices for the ad hoc build:" (multiselect) | `credentials/ios/actions/DeviceUtils.js` | ✅ selects every device, submits only after it has checked that every visible item is selected | — |
| 11 | All devices present: "Would you like to reuse the profile?" | `SetUpAdhocProvisioningProfile.js` | ✅ yes | — |
| 12 | Apple refused devices: "Do you want to continue without provisioning these devices?" | `SetUpAdhocProvisioningProfile.js` | ✅ yes, unless the list contains `--udid`; then 🙋 stop (recommended) or build without it | — |
| 13 | Existing Apple profile: "Would you like to reuse …?" (`SetUpProvisioningProfile.js`) | `credentials/ios/actions/SetUpProvisioningProfile.js` | ❌ unverified whether the reuse rule's wording matches this prompt | — |
| 14 | Replace with credentials.json? | `SetUpTargetBuildCredentialsFromCredentialsJson.js` | ❌ | — |
| 15 | "iOS app only uses standard/exempt encryption?" | `project/ios/exemptEncryption.js` | ❌ | — |
| 16 | Install expo-dev-client / configure expo-updates / "What is the next build number?" | `build/utils/devClient.js`, `build/runBuildAndSubmit.js`, `build/utils/version.js` | ❌ | — |
| 17 | Upload starts (no prompt: "Compressing project files") | `build/` | 🙋 EAS paused, summary shown, build only after a yes | — |
| 18 | Build link printed | `build/` | ✅ captured; `--udid` then follows the build and checks every profile in the IPA | — |

**Not covered by any prompt answer:** a device that Apple has not finished processing (up to 72 h).
eas-autopilot reports it at #12 and stops before anything is built.

## Other EAS flows

| Flow | eas-cli prompts | eas-cli non-interactive path | @expo/agent-cli | eas-autopilot |
| --- | --- | --- | --- | --- |
| iOS internal build, all devices, no prompts | 25 iOS credential + 9 Apple login | `--non-interactive --refresh-ad-hoc-provisioning-profile`; needs an App Store Connect API key for **every** target, extensions included | — | ✅ `eas-ios-adhoc` (rows above) |
| iOS store build | same credential set, minus devices | `--non-interactive` once credentials exist on EAS | — | ❌ record → learn a Flow |
| iOS simulator / development build on EAS | few (profile, dev-client) | `--non-interactive` | ✅ `dev --ios --eas`: builds the `development-simulator` profile (added to `eas.json` when missing), reuses a finished build of the same fingerprint | ❌ |
| EAS Simulator session | "Select platform" | `simulator --non-interactive` | ✅ `dev --eas`, `smoke --eas`, `navigate --eas`, `dev:stop --eas` | — |
| Android build | 14 Android credential | `--non-interactive` once a keystore exists | — (only via `dev --android --eas` for development builds) | ❌ |
| Device registration `eas device:create` | 13 (method, UDID, name, class, import from portal) | not checked | — | ❌ |
| Submit to App Store / Play | 14 | `--non-interactive` with an ASC key or Google service account | 🙋 `deploy --native` stops at a launch.expo.dev URL; signing and submission happen in the browser | ❌ |
| EAS Update, channel, branch, rollout | 28 | flags (`--branch`, `--message`, `--non-interactive`) | — | ❌ |
| Web deploy (EAS Hosting) | 3 | `eas deploy --non-interactive` | ✅ `deploy --web` (`expo export` then `eas deploy`) | — |
| Env variables and secrets | 17 | flags | — | ❌ |
| Project init / new | 27 | flags | ✅ `new` creates a project without prompts | — |
| Workflows | 10 | flags | — | ❌ |
| Credentials manager `eas credentials` | 24 iOS + Android menus | none (menu-driven) | — | ❌ |
| Integrations (Convex, PostHog, Supabase, ASC) | 27 | partly | — | ❌ |
| Build log diagnosis | — | — | ✅ `inspect:build-log` | — |
| Other (observe, upload, webhook, metadata, account, fingerprint) | 70 | mostly flags | — | ❌ |

## How the two tools differ

- **@expo/agent-cli** drives eas-cli with `--non-interactive` for the paths it owns (development
  builds, EAS Simulator, web deploy). It has no ad hoc provisioning or credential prompts to answer,
  and it hands store signing to a browser.
- **eas-autopilot** runs eas-cli interactively in a pseudo-terminal, where the Apple-ID-session
  credential flow lives, and answers from a Flow. Each ❌ above becomes a Flow rule through
  `record` → `learn` → `check`.
