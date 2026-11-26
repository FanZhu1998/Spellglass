# Spellglass

Trace a spell in the air with your wand and watch the mirror answer.

Spellglass is a browser app, and a desktop app for Windows and Mac that opens with a double-click. It follows the tip of an interactive wand through your computer's camera, recognizes the spell you trace (and, in a browser, say aloud), and answers on screen with light, sound and a shelf of props that react. The design is [spellglass-blueprint.md](spellglass-blueprint.md).

*Spellglass is an unofficial fan project. It is not affiliated with or endorsed by Warner Bros. or Universal. It uses original art, open-licensed fonts and synthesized sounds.*

## Desktop app

The desktop app is Spellglass in one file: no browser, no internet connection, no commands. Everything it needs is inside, the hand-tracking model included.

### Playing

**Windows.** Double-click `Spellglass-0.1.0.exe` (the number is the version). Nothing is installed: a Spellglass picture shows while the file unpacks itself, then the mirror opens, in about 5 seconds (the very first start of a new file can take 10, while Windows scans it; there is nothing on screen for the first few). The file unpacks into the temp folder at each start, so it needs about 350 MB free there; closing the app removes the copy, and the next start clears any copy a crash left behind. Until the app is signed, Windows may say "Windows protected your PC" the first time: choose **More info**, then **Run anyway**. On a Windows 11 PC with **Smart App Control** on, an unsigned file from the internet is blocked outright, with no "Run anyway": such PCs need the signed app (below). If you would rather have Spellglass in the Start menu, run `Spellglass-Setup-0.1.0.exe` instead: it installs for you alone, with a Start menu entry and a desktop shortcut, and is removed in Settings › Apps.

**Mac.** Open `Spellglass-0.1.0-mac.dmg` and drag Spellglass onto Applications, then open it from there. It runs on Apple silicon and Intel Macs alike. Until the app is signed, macOS refuses it the first time ("Apple could not verify…"): open **System Settings › Privacy & Security**, scroll to the message about Spellglass, choose **Open Anyway** and confirm. After that it opens like any other app. `Spellglass-0.1.0-mac.zip` holds the same app, for those who prefer it to a disk image.

**The camera.** The first time you choose a camera route on a Mac, macOS asks whether Spellglass may use the camera: choose Allow (if you chose not to, turn Spellglass on in System Settings › Privacy & Security › Camera). Windows does not ask, but desktop apps must be allowed the camera in Settings › Privacy & security › Camera. Casting with a wand or your hand? See [Playing with your wand](#playing-with-your-wand) and [Playing with your hand](#playing-with-your-hand) for how to hold it and the camera features to turn off.

- **F11** turns full screen on and off (on a Mac: Control-Command-F, or the green button). With integrated graphics on a 4K screen, full screen can be more than the GPU draws in time: measured on one such machine, about 36 frames a second and the trail 84 ms behind the camera, against 60 and 31 ms in the default window. If casting feels sluggish there, play in a window.
- Progress, drawings, keepsakes and settings stay on the computer (`%APPDATA%\Spellglass` on Windows, `~/Library/Application Support/Spellglass` on a Mac) and survive closing the app and new versions of it. They are separate from Spellglass in a browser: to move them, use Workshop › Your data › Export my data, and import the file on the other side.
- Cards, clips and exported data go to your Downloads folder.
- Opening Spellglass while it is open brings its window forward.

### What does not work in the desktop app

- **Voice.** Electron, which the desktop app is built on, has no working speech recognition: there are no on-device language packs (Chrome downloads those), and a session with the online speech service opens the microphone only to end in a network error. So the desktop app leaves voice out: the Workshop says it is not available, and spells are cast by gesture. Voice works in Chrome or Edge.
- **Replay links and the QR code**, unless the app was built with the web version's address (`SPELLGLASS_WEB_URL`, below). The desktop app's own address, `app://spellglass/`, opens nowhere else, so Keepsakes says there are no replay links and offers cards and clips.
- **The system share sheet.** Links are copied, and cards and clips are saved as files.
- **Updates.** The app does not update itself; a new version is a new file, and progress carries over.
- **Signing.** The files are not signed yet, hence the warnings above.
- Only Windows (x64) and macOS are packaged; there is no Linux package yet.

### Building it

| Command | Does |
|---|---|
| `npm run desktop` | Builds `dist/` and opens it in Electron, as the packaged app would; F12 opens the developer tools |
| `npm run desktop:win` | Builds and packages for Windows into `release/`: `Spellglass-<version>.exe` (portable, the file to double-click), `Spellglass-Setup-<version>.exe` (installer) and `win-unpacked/` |
| `npm run desktop:mac` | The same on a Mac: `release/Spellglass-<version>-mac.dmg` and `-mac.zip` (Apple silicon and Intel in one), and `mac-universal/Spellglass.app` |
| `npm run desktop:win -- --test-build` | A test build for the tests below, only the unpacked app, in `release/test/`. It keeps the `--inspect` switch the tests drive it through, which a release build ignores: never give it to players |
| `npm run test:desktop` | Builds `dist/`, then runs the Electron tests in `tests/desktop/` against it, and against the test build, the release build and the portable `.exe` in `release/` when they are there |

Run `npm run models` before packaging: the hand-tracking model goes in only when it is in `public/models` (the packaging step warns when it is not). On Windows the portable `.exe` is about 150 MB and the installer about 117 MB; the portable file packs the app as a zip rather than 7z because it unpacks itself at every start, and that way the mirror opens in about 5 seconds instead of 12.

`.github/workflows/desktop.yml` builds both on `windows-latest` and `macos-latest` for every push, of a branch or of a tag such as `v0.1.0`, and by hand (Actions › Desktop app › Run workflow): it runs the checks, packages, runs the Electron tests, and only then uploads the files as the run's artifacts (GitHub hands them out zipped). Nothing is published.

To give the desktop app its QR code and replay links, build it with the web version's address, for example `SPELLGLASS_WEB_URL=https://spellglass.example.com/ npm run desktop:win` (in PowerShell, `$env:SPELLGLASS_WEB_URL = 'https://spellglass.example.com/'` first), or set it as a repository variable for the workflow. It must be an https address; replay links made in the desktop app then open there.

How it fits together:

- `desktop/main.mjs` is Electron's main process, plain ESM with nothing to compile. It serves `dist/` at `app://spellglass/`, a privileged scheme (`desktop/protocol.mjs`), so the page is a secure context with an origin of its own: workers, WebAssembly, IndexedDB, `crypto.subtle` and the camera behave as they do over https. Each file gets its content type, a missing one a 404, and nothing outside `dist/` can be reached.
- `desktop/policy.mjs` holds the rules the main process applies. It refuses every request that is not to `app://spellglass/`, from any page or worker, whatever its own policy says (Section 11.2). It grants the camera and the microphone, plus the clipboard write and the durable storage Chrome grants without asking, to the app alone, and refuses everything else (location, notifications, screen capture, devices). The window stays on the app: web links open in the system browser, the tip finder opens in a window of its own, and nothing else opens or navigates. The page runs with context isolation, the sandbox and no Node.js. There is no menu bar on Windows and the standard menus on a Mac, and the developer tools are off in a packaged app unless `SPELLGLASS_DEVTOOLS=1` is set.
- The page knows it is the desktop app from `location.protocol` (`src/main.ts`): it registers no service worker, leaves the speech API out, and words a few sentences for a computer rather than a browser tab.
- `electron-builder.config.mjs` packs only `package.json`, `desktop/*.mjs` and `dist/` (without source maps or `node_modules`) into an asar, sets Electron's fuses that cost nothing (no running as plain Node, no `NODE_OPTIONS`, only the asar is loaded), and names the files. `tools/desktop.mjs` runs the web build with the base path `/` first. `tools/make-splash.mjs` redraws `desktop/splash.bmp`, the picture the portable `.exe` shows while it unpacks.
- Two switches exist for the tests: `--spellglass-user-data=<dir>` (another user data folder) and `--spellglass-fake-camera[=<clip.y4m>]` (Chrome's fake camera).
- `Cannot find module 'electron'` from Electron means `ELECTRON_RUN_AS_NODE=1` is set in the environment (some editors set it), which starts Electron as plain Node. The npm scripts and the tests remove it, and the packaged app ignores it.

### Getting the files to players

The workflow's artifacts are for you, not for players: GitHub zips them, asks for a sign-in, and deletes them after 30 days. To hand Spellglass out, attach the files to a **GitHub Release** (Releases › Draft a new release, or `gh release create v0.1.0 release/Spellglass-0.1.0.exe ...`), which gives each one a plain download link, or put them anywhere players can download a file. Players download `Spellglass-0.1.0.exe` (Windows) or the `.dmg` (Mac) and double-click it.

### Signing and notarizing, later

Unsigned apps meet the warnings above. To sign:

- **Windows:** a code-signing certificate, given to electron-builder as `CSC_LINK` (the .pfx file, or its base64) and `CSC_KEY_PASSWORD`, or Azure Trusted Signing through `win.azureSignOptions`. SmartScreen warns less as a signed app earns reputation.
- **macOS:** a Developer ID Application certificate as `CSC_LINK` and `CSC_KEY_PASSWORD` (with one given, the config stops signing ad hoc), and notarization with an App Store Connect API key in `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. The app is already built with the hardened runtime and `desktop/entitlements.mac.plist` (camera and microphone); once it is signed with a Developer ID, the `disable-library-validation` entitlement, needed only for ad hoc signing, can go.
- Settle `appId` in `electron-builder.config.mjs` before the first signed release: Windows and macOS know the app by it.
- In the workflow, pass these as repository secrets to the packaging step.

## Quick start

You need Node 22 or later and Chrome or Edge on a laptop or desktop.

```sh
npm install
npm run models      # optional: the hand-tracking model (about 8 MB) for "The tip of my wand" and "My hand or finger"
npm run dev         # then open http://localhost:5173
```

Open the app on `localhost` or over `https`. Browsers allow the camera only in a secure context, and the app checks each spell pack's SHA-256 with an API that is also secure-context only, so a plain `http://192.168.…` address shows no camera and no spells.

The first visit asks how the app should see your wand:

| Route | You need | How it works |
|---|---|---|
| The tip of my wand | The wand, in ordinary room light | A hand-landmark model finds the hand that holds the wand; around it, the frame shows the wand as a thin bar leaving the fist, and the bar's far end is the tip ([more](#playing-with-your-wand)) |
| My hand or finger | Nothing | A hand-landmark model follows your index fingertip |
| The glint of my wand's tip | A small light touching the bezel beside the lens (a phone flashlight works), or the white screen band from Wand tuning, and a dim room | The tip reflects light straight back toward its source, so it becomes the brightest dot in the frame |
| An infrared camera | A USB camera with infrared LEDs around the lens | The same as the glint, in a band where the room is dark |
| Mouse or touch | Nothing, no camera | Press, trace, release |

To cast: **hold still, trace the spell, hold still again.** Small, slow gestures from the wrist work best. Clear an arm's length plus the wand around you.

Access (Workshop › Settings): seated play (a smaller play area, lower in the view), voice-only and gesture-only casting, a left-handed switch that mirrors every gesture, a high-contrast trail, reduced motion, and captions for every sound.

### Can your camera see the wand tip?

Start with the one-evening test in Appendix A of the blueprint. The tip finder at `/tools/tip-finder.html` (`http://localhost:5173/tools/tip-finder.html` while `npm run dev` runs) shows what the tracker sees and the tip's brightness against the brightest background (aim for 3× or more). It can also record a 10-second session as a test fixture. It shares the app's settings on purpose, so the threshold and exposure you find become the app's starting values.

### Playing with your wand

"The tip of my wand" finds the wand itself, with no light by the lens and no dark room. The hand-landmark model finds the hand that holds the wand; in the picture around that hand, the wand is a thin, straight bar, darker or lighter than what is behind it, leaving the fist, and its far end is the tip. The tracker learns where the tip sits in your hand, so when a fast stroke smears the shaft (at 30 frames a second, a quick flick always does) the tip is carried on the hand, turning as your wrist turns, and when the shaft is seen again the tip goes straight back to it. If the tip is lit, by a light beside the lens as for the glint, the glint at the end of the shaft marks it more exactly.

- **Hold the wand across the camera's view**, not pointed at it: pointed at the lens, the shaft shrinks to a stub the camera cannot measure.
- **Give it something to stand out against.** A dark wand in front of a pale wall is easy; in front of dark clothes, much harder. If the mirror says "Hand found, but not the wand", move so the wand has a plainer background, or light the room more.
- The tips for the hand below apply too, above all turning off a webcam's own tracking, framing and HDR.
- **Wand tuning** shows what it sees: the hand's landmarks, the shaft it found drawn over the picture, and how often the wand was seen in the last second.

If you chose "The tip of my wand" in an earlier version, which followed the glint alone, the app moves you to this route; "The glint of my wand's tip" is still there for a light beside the lens in a dim room, and the infrared camera keeps its own route.

How it was measured: on clips of a real fist photo (MediaPipe's test picture of a thumbs-up, turned so the forearm points down) holding a drawn wand, moved so the wand's tip traces the spells' paths while the wrist tilts the wand, through the real app and hand model, at 1280 × 720 and 30 frames a second. Five clips (sharp; smeared by a 1/60 s and by a 1/30 s exposure; with tremor and a wobbling hand; with a lit tip) of 20 casts each:

| | The tip of my wand | The old guess past the knuckles (grip mode) |
|---|---|---|
| Spells cast right | 98 of 100 | 77 of 100 |
| Tip's distance from the true tip while tracing, median (95th percentile) | 0.0004 to 0.003 frame widths (0.012 at most) | 0.134 frame widths (0.152) |
| Frames of a stroke in which the shaft was seen | 80% (1/30 s) to 100% (sharp); the rest carried on the hand | none |

The two it missed were the same Protego in the sharp clip, where the hand model lost the hand photo during the still beat before it, which grip mode missed as well. Finding the wand adds about 2.5 ms a frame in the hand worker (6.5 ms at the 95th percentile), on top of the hand model's 17 to 35 ms.

### Playing with your hand

"My hand or finger" follows your index fingertip with a hand-landmark model, which needs a steady, clear picture of the hand:

- **Turn off what moves or reworks the picture**, in the camera's own app, while you play. Some webcams, the Insta360 Link 2 among them, do all of this: AI tracking and auto-framing pan and zoom the picture under your finger, gesture control may zoom or start tracking when it sees your raised hand, and HDR or other processing that merges or smooths frames can smear a quick flick.
- **Light the hand** from the front or the side, not with a bright window behind you.
- **Stand close enough that your hand is not tiny.** Once your palm, wrist to middle knuckle, spans less than about 5% of the picture's width, the model finds the hand in fewer and fewer frames; a wide or 4K webcam makes a hand that small at 1.5 to 2 m. The mirror then says "Your hand looks small to the camera": step closer, or zoom the camera in.

Short gaps are forgiven: the tracker keeps your fingertip through 0.4 s without a hand, and when a quick flick blurs your finger into your fist, the tip stays where the finger would be.

## The spells

27 spells in three packs: 12 core charms, 12 further spells, and the restricted section, which is off by default. Spells open in tiers as you learn them (three good casts each); "Open every spell" in the Workshop skips the staging. You can redraw any gesture your own way in the Workshop; your drawing is stored on your device and the pack is left alone.

Nobody has to learn the gestures first. The **spell guide** stays open beside the mirror while you cast (the "Spell guide" button hides it): every spell you can cast now, with its gesture, a one-line hint and how close it is to learned. Choose one to see its gesture drawn faintly on the glass. A cast lights its card, and a near miss marks the spell it was close to. The full Spellbook shows each gesture drawing itself, with its story and Practice.

The look is a candlelit study in an old castle: a gilded mirror on a stone wall above an oak mantel, a brass-and-wax interface, a leather-bound book. All of it is original procedural art (Canvas, SVG and CSS); no film imagery, crests, logos or franchise typeface.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build in `dist/` (installable, works offline) |
| `npm run preview` | Serve the production build |
| `npm test` | Unit tests and recorded-session tests (Vitest) |
| `npm run test:perf` | The time budgets of Section 13 (recognizer 50 ms, tracker step 4 ms), one file at a time. Run on a quiet machine before a release |
| `npm run perf:casting` | Long main-thread tasks while casting, with the mouse and a fake camera (Section 13). Serve the build first (`npm run preview`); run on the reference laptop with a real GPU |
| `npm run test:e2e` | End-to-end tests in Chrome with a fake camera (Playwright, against the production build) |
| `npm run typecheck` | TypeScript and Svelte checks |
| `npm run lint:deps` | Enforces the module dependency rule |
| `npm run lint:packs` | Checks every pack: schema, ids, hashes, effects, contrast, gesture separation |
| `npm run packs:index` | Rewrites `public/packs/index.json` hashes after editing a pack |
| `npm run lab` | Gesture lab: template separation and the simulated recognition table |
| `npm run fixtures:sessions` | Regenerates the synthetic recorded sessions in `tests/fixtures/sessions` |
| `npm run models` | Downloads the hand-tracking model and copies its WebAssembly runtime into `public/models` |
| `npm run check` | Type checks, both lints and the tests (what CI runs) |
| `npm run desktop`, `desktop:win`, `desktop:mac`, `test:desktop` | The desktop app: open it, package it, test it (see [Desktop app](#desktop-app)) |

On Windows, run the tests through npm (or `node tools/run-vitest.mjs`): Vitest started from a shell that reports the drive letter in lower case loads twice and fails, and the wrapper fixes that.

The end-to-end tests run Chrome with `--disable-gpu`. Headless Chrome draws through a software GPU that compiles its shaders the first time the stage uses a canvas effect, which holds input back for several seconds on the first press; the tests check what the app does, not how the GPU draws it.

The desktop tests use `--disable-gpu` on Windows only (`GPU_SWITCHES` in `tests/desktop/app.ts`). On a Mac, Chromium has no software GL to fall back on: with that switch its GPU process gives up at the start, which leaves no WebGL (the hand tracker's MediaPipe needs it, on the CPU too) and the camera at 5 frames a second. So on a Mac they run with the machine's GPU, as players do. On Windows the hand tracker's GPU delegate then runs on software WebGL, about ten times slower than its CPU delegate, so after its first ten frames the tracker loads the model again on the CPU, as it does for a player without a usable GPU; the log says so.

## How it is built

The app is a pipeline of small modules around an event bus (blueprint Section 5):

```
camera → capture → tracker → filter and segmenter → recognizer → spell engine → effects (stage, audio)
                                              voice ↗
```

- `src/contracts/` holds the only things modules share: data types, events, requests, settings, pack formats and JSON Schemas. Contract 1.3 is the blueprint's 1.0 plus additive fields, each marked `@since 1.1`, `@since 1.2` or `@since 1.3` (1.2 adds a tracker's segmentation needs and the 'hand-too-small' hint to `tracker.status`, and the same needs to a recorded session, so that it replays as it played; 1.3 adds the hand tracker's wand mode: the 'wand-not-seen' hint and a `wand` readout in `tracker.status`, and the shaft found in `tracker.debug`). A wand tip is published as a `TipSample` like any other, so nothing after the tracker changed. Settings are at version 2: the step from 1 moves "The tip of my wand" from the glint to the wand in the hand (`SETTINGS_MIGRATIONS` in `src/kernel/settings.ts`).
- The wand finder is `src/modules/trackers/hand/wand.ts`: pure functions over the brightness of the region around the hand, which the hand worker reads from the camera frame after the landmarks (`luma.ts`). Lines through the grip are voted for by the edges outside the hand (a Hough transform kept to the lines a held wand can lie on), and each is checked along its length for a bar against both sides. `tracking.ts` (`WandTip`) keeps the tip in the hand's own frame from frame to frame. A better finder later, a learned one say, only has to return the same `WandWire` (`protocol.ts`).
- `src/kernel/` holds the bus (run to completion), the module registry and lifecycle, feature detection, settings, named requests and the pack loader, and the frame feed both camera trackers read the camera track through where Chromium allows it (`frame-feed.ts`).
- `src/modules/` holds one folder per module. Modules never import each other; `npm run lint:deps` fails the build if one does.
- `src/ui/` is the Svelte 5 shell. It talks to the kernel, never to modules.
- `src/main.ts` is the only file that wires modules together.
- `public/packs/` holds the spells and the theme as data packs. Adding a spell is an edit to a pack, not to code.
- `desktop/` is the desktop app's Electron main process, which serves the same build (see [Desktop app](#desktop-app)).

Developer pages that are not part of the build: the stage harness (`src/modules/effects/stage/core/dev/`), the props harness (`…/stage/props/dev/`) and the hand-tracker page (`src/modules/trackers/hand/dev/`). Each folder's scripts say how to run and screenshot it.

## Adding a spell

1. Add an entry to a pack in `public/packs/` (see `core-charms/pack.json`): an incantation, a gesture (a flick or a path in a unit square), and effect steps built from the primitives in `src/contracts/effects.ts`.
2. Run `npm run lint:packs` (it fails if the new gesture is too close to another) and `npm run packs:index`.

## Privacy

- Camera frames are processed in the tab and never leave it. There is no analytics and no account.
- Voice recognition runs on the device or stays off, unless you opt in to the browser's online service, and the app says so when it does.
- The hand-tracking library (MediaPipe) tries to send usage logs to Google from inside its worker, where the page's content security policy does not reach. The hand tracker's worker blocks every request that leaves the app's own origin, so nothing is sent.
- The desktop app also refuses, in its main process, every request that is not to its own files, from any page or worker.
- A shared replay link carries only the traced shape, the spell and the grade. Clips leave your camera image out unless you tick "Include my camera".

## Safety

- Every pack, imported ones included, is held to the limits of blueprint Section 10.6 after its effect scale: at most three flashes a second, none filling the screen, saturated red kept dim. What the flash budget refuses is drawn softly, under the rate that counts as a flash: a refused flash becomes a slow glow, a refused bolt a faint trace, and every soft change on screen shares one allowance so several at once cannot add up to a flash.
- A pack from someone else is refused with a plain reason if it is nested too deeply or would make too many gesture templates to match quickly, and a broken import leaves everything as it was. Storage refuses a value it cannot keep and goes on saving everything else.
- Progress is counted safely across tabs: each tab hears the others' changes, and saves take turns.

## What has not been tried yet

Everything above is covered by about 1,700 automated tests, and the camera pipeline has cast spells end to end in Chrome from a fake-camera clip of a bright dot. The time budgets of Section 13 hold in `npm run test:perf`; in headless Chrome on the development machine, without a real GPU, casting now and then runs one 50 to 130 ms task around the first casts of a session, so measure on the reference laptop before a release (`npm run preview`, then `npm run perf:casting`). Not yet tried with real hardware:

- a real wand and webcam (Appendix A is the first step);
- camera exposure control (Chrome's fake camera offers none);
- voice with a real microphone and a downloaded language pack;
- the wand route, which was measured on clips of a real hand photo holding a drawn wand, not yet with a real wand and webcam: a wand the colour of what is behind it, a shiny or carved shaft, other grips and other lighting are all untried;
- the hand tracker's grip mode ("Past your knuckles"), now the fallback for a wand the camera cannot make out, which still needs tuning against real casts;
- the hand route's rules for gaps, collapsed fingers and small hands, which were measured on simulated hand noise and on clips of a hand photo, not yet on a live hand;
- the hand tracker reading the camera track directly, which was measured as a prototype with Chrome's fake camera, and its move to the CPU when the GPU delegate is slow, neither yet with a real webcam;
- the sounds, which were measured for level but not judged by ear;
- the Mac desktop app, which only the workflow builds (on `macos-latest`): it has not been opened on a Mac yet.

## Deploying

Pushing to `main` runs `.github/workflows/deploy.yml`, which tests, downloads the hand model, builds with the base path `/<repository>/` and publishes to GitHub Pages. The desktop app has its own workflow, `.github/workflows/desktop.yml` (see [Desktop app](#desktop-app)).

Mind the origin. Browsers grant camera permission and keep IndexedDB and localStorage per origin, not per path. Served as a path of a domain that hosts other pages (`example.com/Spellglass/`), Spellglass shares all three with every page and script on that domain: once a player allows the camera, any of them can open it without asking, and any of them can read or delete the player's keepsakes, learned strokes and settings. The privacy promises of Section 11.2 then rest on everything else served there. An origin of its own avoids this: a subdomain such as `spellglass.example.com` set as the repository's Pages custom domain, built with `BASE_PATH=/`.

## License

MIT for the code (see [LICENSE](LICENSE)). The fonts are IM Fell English and Spectral under the SIL Open Font License.
