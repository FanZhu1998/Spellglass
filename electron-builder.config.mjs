// @ts-check
// Packaging for the Spellglass desktop app (README, "Desktop app"). Use it through the npm scripts,
// which build the web app first and pass this file to electron-builder:
//
//   npm run desktop:win   release/Spellglass-<version>.exe (portable: the file to double-click)
//                         release/Spellglass-Setup-<version>.exe (an installer, if preferred)
//   npm run desktop:mac   release/Spellglass-<version>-mac.dmg and .zip, for Apple silicon and Intel (on a Mac)
//
// With SPELLGLASS_TEST_BUILD=1 (`npm run desktop:win -- --test-build`, and the same for desktop:mac)
// it makes the test build instead: only the unpacked app, in release/test/, which keeps the debugging
// switches that Playwright drives the packaged app through (tests/desktop). Never hand that one out.
//
// What goes in: package.json, desktop/*.mjs (the main process) and dist/ (the web build, with the hand
// model in dist/models when `npm run models` ran first). No source, no tests, no node_modules.

import { readFileSync } from 'node:fs';

const license = readFileSync(new URL('./LICENSE', import.meta.url), 'utf8');
const copyright = /^Copyright .+$/m.exec(license)?.[0].replace('(c)', '©');

const testBuild = process.env.SPELLGLASS_TEST_BUILD === '1';

/** Signing comes later (README). With no certificate given (CSC_LINK or CSC_NAME), the Mac app is
 *  signed ad hoc, which Apple silicon needs to run it at all; with one, electron-builder signs with
 *  it, and notarizes when the APPLE_* variables are set too. */
const macCertificate = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
/** Ad hoc signing has no Team ID, so the hardened runtime's library validation would refuse Electron's
 *  own frameworks: that build needs the entitlement that turns it off, a Developer ID build does not. */
const macEntitlements = macCertificate ? 'desktop/entitlements.mac.plist' : 'desktop/entitlements.mac.adhoc.plist';

/** @type {import('electron-builder').Configuration} */
export default {
  // Identifies the app to Windows and macOS (and the installer's upgrades): settle it before the first
  // signed release. Settings and progress live under productName, so changing it keeps them.
  appId: 'app.spellglass.desktop',
  productName: 'Spellglass',
  copyright,
  directories: { output: testBuild ? 'release/test' : 'release' },
  files: ['package.json', 'desktop/*.mjs', 'dist/**/*', '!dist/**/*.map'],
  asar: true,
  // The packaged package.json. Its description is the "File description" of the Windows launcher and
  // installer (Task Manager shows it as the app's name), so it is the name; main.mjs reads the test flag.
  extraMetadata: { description: 'Spellglass', ...(testBuild ? { spellglassTestBuild: true } : {}) },
  // The main process uses only Electron and Node, and Vite has bundled everything the page needs, so
  // no node_modules go in. Resolving false tells electron-builder that node_modules are handled here.
  beforeBuild: async () => false,
  // The interface is in English; Chromium falls back to its English strings everywhere else.
  electronLanguages: ['en-US'],
  icon: 'public/icons/icon-512.png',
  // Hardening that costs nothing here: the app cannot be run as plain Node, NODE_OPTIONS is ignored,
  // only app.asar is loaded, file:// pages get no extra powers (the app uses app://), and --inspect and
  // its kin are ignored, so a signed Spellglass cannot be made to run someone else's JavaScript. (The
  // main process drops Chromium's remote debugging too.) Only the test build keeps --inspect.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: testBuild,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  publish: null,

  win: {
    target: [
      { target: 'portable', arch: ['x64'] },
      { target: 'nsis', arch: ['x64'] },
    ],
  },
  portable: {
    artifactName: '${productName}-${version}.${ext}',
    // The portable .exe unpacks the app into a temporary folder at every start: a zip unpacks several
    // seconds sooner than 7z, and the splash (tools/make-splash.mjs) shows at once meanwhile.
    useZip: true,
    splashImage: 'desktop/splash.bmp',
    // Each start unpacks into a temporary folder of its own. With one shared folder (the default), a
    // second double-click while Spellglass runs empties the running copy's folder and stops on an error;
    // this way the second copy starts, hands over to the open window (single instance) and cleans up.
    // The documentation says `false` for this, but electron-builder 26.18.0 reads it backwards (a falsy
    // value gets a shared name made at build time, NsisTarget.js): `true` is what gives each start its
    // own folder. tests/desktop checks it ("a second double-click"); look again when upgrading.
    // A copy whose launcher was stopped before it could clean up is removed later (desktop/portable.mjs).
    unpackDirName: true,
  },
  nsis: {
    artifactName: '${productName}-Setup-${version}.${ext}',
    oneClick: true,
    perMachine: false,
    // Uninstalling keeps the player's progress (in %APPDATA%\Spellglass), as the portable app does.
    deleteAppDataOnUninstall: false,
  },

  mac: {
    // One file for every Mac: Apple silicon and Intel in one app (universal).
    artifactName: '${productName}-${version}-mac.${ext}',
    target: [
      { target: 'dmg', arch: ['universal'] },
      { target: 'zip', arch: ['universal'] },
    ],
    category: 'public.app-category.games',
    darkModeSupport: true,
    hardenedRuntime: true,
    entitlements: macEntitlements,
    entitlementsInherit: macEntitlements,
    identity: macCertificate ? undefined : '-',
    extendInfo: {
      NSCameraUsageDescription: 'Spellglass follows the tip of your wand through the camera. The picture is processed on this Mac and never leaves it.',
      // The desktop app has no voice and never opens the microphone (desktop/policy.mjs), so it says
      // nothing about one: null removes the key, Electron's own sentence included.
      NSMicrophoneUsageDescription: null,
    },
  },
  dmg: {
    title: '${productName} ${version}',
  },
};
