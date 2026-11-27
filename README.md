# Spellglass

Trace a spell in the air with your wand and watch the mirror answer.

Spellglass is a browser app, and a desktop app for Windows and Mac that opens with a double-click. It follows the tip of your wand (an interactive one from the parks, or any thin, straight wand) or your fingertip through your computer's camera, or simply the mouse. It recognizes the spell you trace (in a browser it can also listen for the incantation), and answers on screen with light, sound and a shelf of props that react. The design is [spellglass-blueprint.md](spellglass-blueprint.md).

*Spellglass is an unofficial fan project. It is not affiliated with or endorsed by Warner Bros. or Universal. It uses original art, open-licensed fonts and synthesized sounds.*

**Contents:** [Getting started](#getting-started) · [Using Spellglass](#using-spellglass) · [The spells](#the-spells) · [Desktop app](#desktop-app) · [Commands](#commands) · [How it is built](#how-it-is-built) · [Adding a spell](#adding-a-spell) · [Privacy](#privacy) · [Safety](#safety) · [What has not been tried yet](#what-has-not-been-tried-yet) · [Deploying](#deploying) · [License](#license)

## Getting started

There are two ways to play: the **desktop app** for Windows or Mac, a file you open, or **in Chrome or Edge**, run from this repository's source with Node. Both play the same, except that only the browser can cast by voice.

### What you need

- **A computer.** For the desktop app, Windows 10 or 11 (x64), or a Mac with macOS 13 Ventura or later (Apple silicon or Intel). For the browser version, a laptop or desktop with Chrome or Edge; other browsers are not supported.
- **A webcam**, built in or USB, for the camera routes. Without one you can still play with a mouse, a trackpad or a touch screen.
- **Something to cast with:** a wand (any thin, straight one, an interactive wand from the parks included), your index finger, or the pointer.
- **Room:** stand 0.6 to 1.2 m from the camera, with an arm's length plus the wand clear around you. Ordinary room light suits the wand and the hand; only the glint route wants a dim room.

### The desktop app

There is no download page yet. Each push to this repository builds the app on GitHub, and the files can be taken from that build:

1. Sign in to GitHub: the build's files are handed out only to signed-in accounts.
2. Open the repository's **Actions** tab, choose **Desktop app** in the list of workflows, and open the newest run with a green tick on the branch `spellglass-app`. Leave the tag `v0.1.0` alone: it points at the first version.
3. At the foot of the run's summary page, under **Artifacts**, download **Spellglass-Windows** or **Spellglass-macOS**. GitHub keeps them for 30 days after the run; if the newest run is older than that, build the files yourself (below).
4. Unzip the download (on Windows: right-click › Extract All).
   - **Windows:** double-click `Spellglass-0.1.0.exe`. It runs without installing anything. `Spellglass-Setup-0.1.0.exe` installs it instead, with a Start menu entry and a desktop shortcut.
   - **Mac:** open `Spellglass-0.1.0-mac.dmg`, drag Spellglass onto Applications, and open it from there. So far the Mac app has been built and tested only on GitHub's Mac machines, never on a player's Mac: if it will not open, play in Chrome or Edge instead ([In a browser, from the source](#in-a-browser-from-the-source)).
5. The files are not signed yet, so Windows and macOS warn the first time you open them. [Desktop app › Playing](#playing) says what to click.

To build the files yourself, follow the browser steps below up to `npm run models`, then run `npm run desktop:win` on Windows or `npm run desktop:mac` on a Mac. The files appear in `release/` ([Building it](#building-it) has the details).

### In a browser, from the source

1. **Install Node.js and Git.** Node.js 24, or a newer LTS release, from [nodejs.org](https://nodejs.org) (npm comes with it), and Git from [git-scm.com](https://git-scm.com). Node 22.12 or later also runs the app; the builds on GitHub use 24.
2. **Get the code.** The app is on the branch `spellglass-app`. The default branch, `main`, holds only the repository's first commit for now, so a plain clone or **Download ZIP** of `main` gets no app.
   ```sh
   git clone --branch spellglass-app https://github.com/FanZhu1998/Spellglass.git
   cd Spellglass
   ```
3. **Install, and fetch the hand model.**
   ```sh
   npm install
   npm run models
   ```
   `npm install` takes a minute or so and prints a few warnings (deprecated packages, install scripts it was not told to allow, an audit summary); none of them stops Spellglass. `npm run models` downloads MediaPipe's hand-landmark model (7.5 MB) and copies its WebAssembly runtime next to it in `public/models`, about 23 MB in all. "The tip of my wand" and "My hand or finger" need it: without it they stop with "Hand model not installed. Run npm run models." The glint, infrared and mouse routes work without it.
4. **Start it.**
   ```sh
   npm run dev
   ```
   Open the address it prints, normally http://localhost:5173, in Chrome or Edge (if port 5173 is taken, it uses the next free one). Press Ctrl+C in the terminal to stop it.
5. **Or play the production build**, which starts faster and works offline:
   ```sh
   npm run build
   npm run preview
   ```
   Then open http://localhost:4173. Chrome and Edge offer to install it (the install icon in the address bar), which gives Spellglass a window of its own. The hand model is cached the first time a hand route is used, so those two routes work offline after one start online. After a new build, reload the page: it still opens the old build and says "A new edition has arrived. Update now, or after this session." Choose **Update now** to play the new one.

Good to know:

- **Open it on localhost or over https.** Browsers allow the camera only in a secure context, and the app checks each spell pack's SHA-256 with an API that is also secure-context only. On a plain `http://192.168.…` address (`npm run dev -- --host` opened from another device, say), every camera route says "Cameras need a secure address. Open Spellglass from its https link, or on localhost." and no spells load.
- **Windows PowerShell** may refuse `npm` with "running scripts is disabled on this system". Run the commands in Command Prompt instead, or allow local scripts once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
- **Each address keeps its own data.** Progress, drawings and settings made at `localhost:5173` are not at `localhost:4173`, on a hosted copy or in the desktop app. To move them, use Workshop › Your data › **Export my data**, and import the file on the other side.

## Using Spellglass

### The first visit

The first page, **Step up to the glass**, asks **How should the app see your wand?** Choose one of five routes:

| Route | You need | How it works |
|---|---|---|
| The tip of my wand | The wand, in ordinary room light | A hand-landmark model finds the hand that holds the wand; around it, the frame shows the wand as a thin bar leaving the fist, and the bar's far end is the tip ([more](#playing-with-your-wand)) |
| My hand or finger | Nothing | A hand-landmark model follows your index fingertip ([more](#playing-with-your-hand)) |
| The glint of my wand's tip | A small light touching the bezel beside the lens (a phone flashlight works), or a white band across the top of the screen (the page offers it: "No light to hand?"), and a dim room | The tip reflects light straight back toward its source, so it becomes the brightest dot in the frame |
| An infrared camera | A USB camera with infrared LEDs around the lens | The same as the glint, in a band where the room is dark |
| Mouse or touch (no camera) | Nothing, no camera | Press on the mirror, trace, let go |

1. **Allow the camera.** Choosing a camera route turns the camera on straight away, so that is when the browser asks: choose **Allow**. The desktop app on a Mac asks once; on Windows it does not ask, but desktop apps must be allowed the camera in Settings › Privacy & security › Camera. In a browser, the two hand routes then download their model once, with a progress bar.
2. **Read the box under the routes.** It says what the mirror is doing: "Camera on.", then for example "Wand found. Hold still, then trace a spell." If the camera is blocked, missing or in use, fix that and choose **Try again**, or choose **Use mouse or touch**.
3. **Choose Start casting.** The mirror opens, with your reflection on a camera route.

You can change the route at any time. **Change how the app sees your wand**, under the mirror, opens this page again. **Tune wand** › How Spellglass sees your wand offers the same five routes, under short names: Wand tip, Hand, Glint of the tip, Infrared camera, and Mouse or touch.

### Casting a spell

On a camera route, every spell is cast the same way:

1. **Hold still.** Keep the tip still for about a third of a second. The ring of ticks round the glowing tip fills, and the tip turns gold: it is ready.
2. **Trace the spell** in one stroke, starting where its drawing starts and going the way it goes.
3. **Hold still again** for a moment. That ends the stroke, and the mirror decides.

With **Mouse or touch**, press on the mirror, trace the spell and let go. On a camera route the mouse draws nothing, because only one way of casting runs at a time.

When the spell is cast, the ink settles into the spell's clean shape, a circle of runes lights round it, the incantation writes itself across the glass, and the effect plays with its sound. A banner at the top names the spell and a grade: **Outstanding**, **Exceeds Expectations** or **Acceptable**. A miss fizzles: the ink drips away, and a scrap of parchment gives a grade (**Poor**, **Dreadful** or **Troll**), the spell it came closest to, and one thing to change, such as "Make the gesture larger." or "Trace it more slowly." Until your first cast, the top of the glass coaches you: "Hold still, trace the spell, then hold still again." and "Try Lumos. Flick straight up."

Tips:

- **Hold properly still** before and after. To start, the tip has to stay within about 2% of the picture's width. A stroke that never pauses runs on until it is cut off at 4 seconds.
- **Make it big enough.** A stroke smaller than 15% of the play area is ignored without a word, and below a quarter of it a miss says "Make the gesture larger." Gestures from the wrist and forearm, a little slower than feels natural, work well. Size and speed add power: a big, quick flick turns Lumos into Lumos Maxima.
- **Follow the drawing's direction and pace.** A shape traced backwards, or turned more than about 15°, does not match. Practice's moving dot shows the pace.
- **End the stroke beside the prop you want.** Spells that act on a prop (Accio, Reparo, Reducto, Locomotor, Engorgio, Reducio) take the one nearest to where the stroke ends.
- **Some spells need another first:** Nox puts out Lumos, so without a light it fizzles with "Cast Lumos first."
- **While you steer a spell** (Wingardium Leviosa, Accio's hover, Locomotor, Imperio), the tip moves it and draws no trail, and strokes that do not cast are dropped quietly until it ends.
- **Mind the room:** keep an arm's length plus the wand clear around you, minding drinks, pets and the monitor.

### What is on the screen

- **The mirror**, with your reflection on a camera route. Along its foot is the shelf the spells act on: a candle, a feather, a locked box, a cracked teacup, a potted plant and the wooden training dummy.
- **The spell guide** beside the mirror (under it in a tall window): every spell you can cast now, with its gesture, a one-line hint and its progress, such as "0 of 3". Choose a card to see that gesture drawn faintly on the glass. After a cast, a card says **Cast**, **Close** (the spell a miss came nearest to) or **New**. The **Spell guide** button hides and shows it.
- **The buttons under the mirror:** **Open spellbook**, **Practice**, **Spell guide**, **Workshop**, **Change how the app sees your wand**, a QR code for opening the app on a phone (when it has a web address), **Tune wand**, and **Share**, which opens your keepsakes.
- **The chips at the top right:** the camera ("camera on"), the tracker ("wand found", "hand not found"), the microphone once voice is on, and "not saving: …" if storage is blocked.
- **Notes at the top of the glass**, when something needs you: the camera is blocked, the hand model is loading, or a tracker hint such as "Hand found, but not the wand. Hold it up across the camera, not pointed at it, with a plain wall behind if you can."
- **This session**, at the top right of the glass in a wide window: your last six results.

### Learning the spells

At first only four spells are open: Lumos, Nox, Wingardium Leviosa and Stupefy. A spell is learned after **3 casts**, of any grade. Practice casts count; replays do not. When every open spell of a tier is learned, the next tier opens: the glass says "A new page opens", and its spells join the guide marked **New**. There are seven tiers, listed in [The spells](#the-spells).

- **Open spellbook** shows every spell of the packs that are on. For each: its gesture drawing itself from the start dot ("Begin at the dot."), the gesture in words, what it does on screen, and how far you are. Up and Down move through the list, and typing a letter jumps to a spell. **Close book** or Escape closes it.
- **Practice this spell**, in the book, shows the spell's gesture faintly on the glass with a dot that moves at the right pace. **Practice** under the mirror does the same for the spell you last chose, or opens the book at the next spell to learn. Each attempt is graded with one hint. **Show me slowly** slows the dot, **Try again** clears the result, and **Back to book** (or Escape) returns to the book.
- To skip the stages, turn on Workshop › Settings › Spells › **Open every spell**. While you learn, fewer open spells mean fewer mix-ups.
- To draw a gesture your own way, open Workshop › **Gestures**, choose the spell, choose **Draw it now**, trace it once in the mirror, then choose **Use this drawing**. It is checked against the other spells first ("This is close to Protego; it may be confused with it."). It is kept on this device only, and **Back to the book's drawing** undoes it.
- Your own clean casts also teach the mirror: once it has three of them for a spell, up to five of the most typical help it recognize that spell, and the Spellbook says "Your own casts now help the mirror know it."

### Casting by voice (in a browser)

Voice is off at first. In Workshop › **Settings**:

1. Under **Voice**, turn on **Listen for incantations**, and allow the microphone when the browser asks. What you say is turned into text on your device. If the browser needs its speech pack first, choose **Download the voice pack**; after that one download, voice works offline.
2. Under **Casting mode**, choose how voice counts. In **Gesture**, the default, only the shape decides, even with voice on.

| Casting mode | What casts the spell |
|---|---|
| Gesture | The shape you trace. For everyday play |
| Assisted | Say the incantation as you trace, and a rougher shape still casts that spell. For beginners, or when tracking is shaky |
| Strict | The shape you trace and the incantation you say must agree. For purists |
| Voice only | The spoken incantation alone. For play without a wand in view |

- While voice is on it listens all the time (there is no button to hold), and it understands US English. The microphone chip at the top shows its state; clicking it turns voice off and on.
- **Use the browser's online speech service** is used only where the browser cannot recognize speech on the device. Your audio then leaves the computer, and the app says so.
- The desktop app has no voice: there, every spell is cast by gesture.

### Keepsakes and sharing

**Share**, under the mirror, opens **Keepsakes**. Your newest 50 casts are kept on this device (older ones are deleted as new ones come), and the newest 40 are listed, newest first. Open one to:

- **Watch again:** replay it in the mirror.
- **Save a card:** a 1200 × 630 picture of the stroke, the spell and its grade.
- **Record a clip:** up to ten seconds of the replay, with its sound, as a video file. Your camera image is left out unless you tick **Include my camera**.
- **Share this cast:** a replay link that opens the cast on any device, without a camera. It needs the app's own address: on localhost the link works only on that computer, and the desktop app makes no replay links unless it was built with a web address ([Desktop app](#desktop-app)).

In a browser, a card, clip or export opens the system share sheet when the browser can share that file, and downloads otherwise. The desktop app saves them to your Downloads folder.

### The Workshop

**Workshop**, under the mirror, holds everything you can set, in six tabs:

- **Settings**
  - **Casting mode** and **Voice** (above).
  - **Spells:** **Open every spell**.
  - **Access:** **Seated play** (a smaller play area, lower in the view, for casting from a chair or a wheelchair), **Left-handed** (mirrors every gesture), **High-contrast trail** (a dark edge on the trail of light, for a bright room), **Reduced motion** (Follow the system, On or Off) and **Captions** (writes each sound on screen, such as [Rising chime]).
  - **Sound:** volume, mute and a sample. **Look:** the house accent colors. **Stage quality:** Automatic, High or Low (lighter work for older computers).
- **Packs:** turn spell packs on and off, and import a pack file with **Choose a pack file**, or by dropping it on the Workshop. The **Restricted section** is off at first.
- **Gestures:** redraw a spell's gesture (above), and **Export my gestures** to share your drawings.
- **Bindings:** a preview of outputs such as room lights, which come in a later version; nothing in it acts yet.
- **Your data:** **Export my data** (one file with your progress, drawings, keepsakes, imported packs and settings), **Import**, and **Delete my data**, which asks first and keeps your settings.
- **Diagnostics:** live timings, **Record a session** (a test fixture), **Reset the shelf** (puts every prop back and ends every spell) and the state of each module.

### Tune wand

**Tune wand** shows what the tracker sees, live: the hand's landmarks and the wand it found, or the bright spot it follows, with how often it holds the tip and how fast frames arrive.

- **How Spellglass sees your wand:** the routes. On the Hand route, **The tip is** chooses **Your fingertip** or **Past your knuckles**, for a wand the camera cannot make out.
- **Camera and distance:** choose the camera, and **Mirror the picture left to right**.
- **Play area:** the box over the view, which spell power and the smallest stroke are measured against. Drag it, drag a corner, or use the arrow keys; **Whole view** resets it.
- For the glint and infrared routes: **Exposure and threshold** (with **Tune automatically**) and **Light and lamps** (the color of your light, **Light the wand with the screen**, **Forget lamps and windows**).
- **Can your camera see the tip?**: open **The tracking test, step by step** for a ten-step test and **Open the tip finder** ([below](#can-your-camera-see-the-wand-tip)).
- **Save for this camera** keeps the exposure, threshold, light color, flip and play area for that camera.

### Keys

Nothing is cast or opened by a keyboard shortcut: everything goes through the buttons. Escape closes the open book or drawer (from Practice, it returns to the book). In the Spellbook, the arrow keys, Home, End, Page Up and Page Down move through the list. For full screen, use the browser's own (F11 on Windows); in the desktop app, F11 on Windows and Control-Command-F on a Mac. Browsers start sound only after your first click or key press in the page.

### Can your camera see the wand tip?

Start with the one-evening test in Appendix A of the blueprint. The tip finder at `/tools/tip-finder.html` (`http://localhost:5173/tools/tip-finder.html` while `npm run dev` runs, or in the app: Tune wand › Can your camera see the tip? › The tracking test, step by step › **Open the tip finder**) shows what the tracker sees and the tip's brightness against the brightest background (aim for 3× or more). It can also record a 10-second session as a test fixture. It shares the app's settings on purpose, so the threshold and exposure you find become the app's starting values.

### Playing with your wand

"The tip of my wand" finds the wand itself, with no light by the lens and no dark room. The hand-landmark model finds the hand that holds the wand; in the picture around that hand, the wand is a thin, straight bar, darker or lighter than what is behind it, leaving the fist, and its far end is the tip. The tracker learns where the tip sits in your hand, so when a fast stroke smears the shaft (at 30 frames a second, a quick flick always does) the tip is carried on the hand, turning as your wrist turns, and when the shaft is seen again the tip goes straight back to it. If the tip is lit, by a light beside the lens as for the glint, the glint at the end of the shaft marks it more exactly.

- **Hold the wand across the camera's view**, not pointed at it: pointed at the lens, the shaft shrinks to a stub the camera cannot measure.
- **Give it something to stand out against.** A dark wand in front of a pale wall is easy; in front of dark clothes, much harder. If the mirror says "Hand found, but not the wand", move so the wand has a plainer background, or light the room more.
- The tips for the hand below apply too, above all turning off a webcam's own tracking, framing and HDR.
- **Wand tuning** (the **Tune wand** button) shows what it sees: the hand's landmarks, the shaft it found drawn over the picture, and how often the wand was seen in the last second.

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

### When something goes wrong

| What you see | What to do |
|---|---|
| "Camera is blocked. Allow camera access in the address bar, then choose Try again." | Click the camera icon in the address bar (or the site settings), allow the camera, then choose **Try again**. The browser itself also needs the camera: on Windows in Settings › Privacy & security › Camera, with desktop apps allowed, and on a Mac in System Settings › Privacy & Security › Camera |
| "Camera is blocked. Allow Spellglass to use the camera in your computer's privacy settings, then choose Try again." (desktop app) | Windows: Settings › Privacy & security › Camera, and let desktop apps use it. Mac: System Settings › Privacy & Security › Camera, and turn Spellglass on |
| "No camera found." or "The camera is in use by another app." | Plug the camera in, or close the app that holds it (a video call, the camera's own app), then choose **Try again** |
| "Hand model not installed. Run npm run models." | Run `npm run models` in the project folder, then choose **Try again** or reload the page. A production build and the desktop app carry only what was there when they were built: after `npm run models`, run `npm run build` again before `npm run preview`, or package the desktop app again |
| "Hand not found. …" (wand and hand routes) | Hold your hand up in view, lit from the front or the side rather than by a window behind you. On the wand route, keep the hand that holds the wand in the picture. Turn off the webcam's own tracking and framing ([Playing with your hand](#playing-with-your-hand)) |
| "Hand found, but not the wand. …" | Hold the wand across the camera's view, not pointed at it, against a plainer background ([Playing with your wand](#playing-with-your-wand)) |
| "Your hand looks small to the camera. …" | Step closer, or zoom the camera in |
| "Wand tip not found. …" (glint and infrared) | Light the tip (a light beside the lens, or the screen band), dim the room, or open **Tune wand** |
| "Too many bright lights in view. …" (glint and infrared) | Dim the lamps behind you, or use **Tune wand** › Light and lamps › **Forget lamps and windows** |
| You trace, and nothing happens | Hold still first, until the tip turns gold; make the gesture bigger; and check that the tracker chip says the wand or hand is found. On a camera route the mouse draws nothing. In the **Voice only** casting mode, traced strokes do nothing while voice works: choose **Gesture** under Workshop › Settings › Casting mode |
| "Cast Lumos first." | Nox puts out Lumos: cast Lumos before it |
| "… is not open yet. Learn the spells before it in the Spellbook." | Learn the earlier tiers, or turn on **Open every spell** |
| "… needs a moment before it can be cast again." | Wait a moment: Lumos, Stupefy, Expelliarmus and Finite Incantatem rest for 0.4 s after each cast |
| "No spells can be cast yet. Turn a pack on in the Workshop." | Turn a pack on in Workshop › **Packs**. If the Spellbook says a pack "could not be opened", open Spellglass on localhost or over https |
| No sound | Click once in the page (browsers wait for that), and check Workshop › Settings › **Sound**. Muffliato muffles every sound until Finite Incantatem |
| A prop stays changed (a costume, a prop in pieces, a mended cup) | Finite Incantatem ends what is still running, Reparo mends what Reducto broke, and Workshop › Diagnostics › **Reset the shelf** puts everything back |
| Casting feels slow in full screen on a 4K screen | Play in a window, or set **Stage quality** to Low |

## The spells

27 spells in three packs: 12 core charms, 12 further spells, and the restricted section, which is off by default. They open in seven tiers as you learn them ([Learning the spells](#learning-the-spells)); "Open every spell" in the Workshop skips the staging. You can redraw the gesture of any spell whose pack is on, your own way, in the Workshop; your drawing is stored on your device and the pack is left alone.

Nobody has to learn the gestures first. The **spell guide** stays open beside the mirror while you cast (the "Spell guide" button hides it): every spell you can cast now, with its gesture, a one-line hint and how close it is to learned. Choose one to see its gesture drawn faintly on the glass. A cast lights its card, and a near miss marks the spell it was close to. The full Spellbook shows each gesture drawing itself from its start dot, with what the spell does on screen and Practice.

**Core charms**

| Tier | Spell | Gesture | What it does |
|---|---|---|---|
| 1 | Lumos | Flick straight up. | Your wand tip ignites; the room dims around it. It stays lit until Nox or Finite Incantatem; a big, quick flick casts Lumos Maxima |
| 1 | Nox | Flick straight down. | The light snuffs; the room returns. It needs Lumos lit |
| 1 | Wingardium Leviosa | Arc over from left to right, then drop straight down: "swish and flick". | The feather lifts and follows your tip, for 8 s |
| 1 | Stupefy | Flick left to right. | A red flash; the dummy reels |
| 2 | Alohomora | Circle clockwise from the top, then straight down through it. | The box unlatches and opens |
| 2 | Accio | A "C": from upper right, around the left, to lower right. | The nearest object flies to your tip |
| 2 | Expelliarmus | A check mark: a short stroke down and right, then a long flick up and right. | A scarlet bolt; the dummy's wand spins away |
| 2 | Protego | A circle, clockwise, from any point. | A rippling dome holds for five seconds |
| 3 | Expecto Patronum | Spiral outward from the centre, two turns clockwise. | A silver creature bursts out and circles the frame |
| 3 | Reparo | A figure-eight on its side, starting at the centre. | The cracked teacup knits together, or a prop Reducto shattered is made whole: the one nearest where the stroke ends |
| 3 | Incendio | A triangle from the lower right: up to the point, down, then back along the base. | The candle catches and embers fly. It burns until Aguamenti or Finite Incantatem |
| 3 | Aguamenti | One wave from left to right: up, down, up. | A water arc from the tip; flames go out |

**Further spells**

| Tier | Spell | Gesture | What it does |
|---|---|---|---|
| 4 | Petrificus Totalus | A "P": straight up, then a bowl around to the middle. | The dummy snaps rigid and topples |
| 4 | Impedimenta | A "J": straight down, then hook to the left. | The dummy moves in slow motion |
| 4 | Riddikulus | A "W". | The dummy gets a silly costume |
| 4 | Revelio | A question mark: hook over the top, then straight down. | Hidden ink and objects shimmer into view |
| 5 | Finite Incantatem | Flick right to left. | Every active effect ends |
| 5 | Obliviate | Spiral inward, two turns clockwise. | Trails and the session log fade away (your progress stays) |
| 5 | Reducto | A one-stroke "X": down and right, straight up, then down and left. | The target bursts to dust; Reparo restores it |
| 5 | Arresto Momentum | An "M" from the lower left. | Everything in motion slows to a stop |
| 6 | Muffliato | A "6": down the left side, then close a loop at the bottom. | Sound is muffled until Finite |
| 6 | Locomotor | An "L": down, then right. | The target slides along the shelf, following your tip left and right, for 5 s |
| 6 | Engorgio | A caret: up, then down. | The target grows |
| 6 | Reducio | A vee: down, then up. | The target shrinks |

**Restricted section** (off by default: turn it on in Workshop › Packs)

| Tier | Spell | Gesture | What it does |
|---|---|---|---|
| 7 | Imperio | An upright figure-eight from the top. | The dummy copies your wand's movement |
| 7 | Crucio | A five-point star from the top. | A red crackle; the dummy recoils |
| 7 | Avada Kedavra | A lightning bolt: down and left, right, then down and left. | A green flash; the dummy drops |

The three curses are drawn as abstract light and sound, and land only on the wooden training dummy. Even with the pack on, they open last, after tiers 1 to 6, unless "Open every spell" is on. With **Left-handed** on, every gesture is mirrored: follow the drawings, which run the other way round. The written path gestures stay as they are, so a "clockwise" circle is then traced the other way; the two sideways flicks are reworded (Stupefy becomes "Flick right to left." and Finite Incantatem "Flick left to right.").

The look is a candlelit study in an old castle: a gilded mirror on a stone wall above an oak mantel, a brass-and-wax interface, a leather-bound book. All of it is original procedural art (Canvas, SVG and CSS); no film imagery, crests, logos or franchise typeface.

## Desktop app

The desktop app is Spellglass in one file: no browser, no internet connection, no commands. Everything it needs is inside, the hand-tracking model included. Where to get the files is in [Getting started](#the-desktop-app).

### Playing

**Windows.** Double-click `Spellglass-0.1.0.exe` (the number is the version). Nothing is installed: a Spellglass picture shows while the file unpacks itself, then the mirror opens, in about 5 seconds (the very first start of a new file can take 10, while Windows scans it; there is nothing on screen for the first few). The file unpacks into the temp folder at each start, so it needs about 350 MB free there; closing the app removes the copy, and a later start clears any copy a crash left behind. Until the app is signed, Windows may say "Windows protected your PC" the first time: choose **More info**, then **Run anyway**. On a Windows 11 PC with **Smart App Control** on, an unsigned file from the internet is blocked outright, with no "Run anyway", and there is no signed app yet ([Signing and notarizing, later](#signing-and-notarizing-later)): on such a PC, play Spellglass in Chrome or Edge ([In a browser, from the source](#in-a-browser-from-the-source)). If you would rather have Spellglass in the Start menu, run `Spellglass-Setup-0.1.0.exe` instead: it installs for you alone, with a Start menu entry and a desktop shortcut, and is removed in Settings › Apps.

**Mac.** Open `Spellglass-0.1.0-mac.dmg` and drag Spellglass onto Applications, then open it from there. It runs on Apple silicon and Intel Macs alike, with macOS 13 Ventura or later. Until the app is signed, macOS refuses it the first time ("Apple could not verify…"): open **System Settings › Privacy & Security**, scroll to the message about Spellglass, choose **Open Anyway** and confirm. After that it opens like any other app. `Spellglass-0.1.0-mac.zip` holds the same app, for those who prefer it to a disk image.

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
| `npm run desktop` | Builds `dist/` and opens it in Electron, as the packaged app would; F12 opens the developer tools. The first run downloads Electron itself |
| `npm run desktop:win` | Builds and packages for Windows into `release/`: `Spellglass-<version>.exe` (portable, the file to double-click), `Spellglass-Setup-<version>.exe` (installer) and `win-unpacked/` |
| `npm run desktop:mac` | The same on a Mac: `release/Spellglass-<version>-mac.dmg` and `-mac.zip` (Apple silicon and Intel in one), and `mac-universal/Spellglass.app` |
| `npm run desktop:win -- --test-build` | A test build for the tests below, only the unpacked app, in `release/test/`. It keeps the `--inspect` switch the tests drive it through, which a release build ignores: never give it to players |
| `npm run test:desktop` | Builds `dist/`, then runs the Electron tests in `tests/desktop/` against it, and against the test build, the release build and the portable `.exe` in `release/` when they are there |

Run `npm run models` before packaging: the hand-tracking model goes in only when it is in `public/models` (the packaging step warns when it is not), and without it "The tip of my wand" and "My hand or finger" do not work. On Windows the portable `.exe` is about 150 MB and the installer about 117 MB; the portable file packs the app as a zip rather than 7z because it unpacks itself at every start, and that way the mirror opens in about 5 seconds instead of 12.

`.github/workflows/desktop.yml` builds both on `windows-latest` and `macos-latest` for every push, of a branch or of a tag such as `v0.1.0`: it runs the checks, packages, runs the Electron tests, and only then uploads the files as the run's artifacts (GitHub hands them out zipped). Nothing is published. Once the workflow is on `main`, it can also be run by hand (Actions › Desktop app › Run workflow): GitHub offers that button only for workflows on the default branch.

To give the desktop app its QR code and replay links, build it with the web version's address, for example `SPELLGLASS_WEB_URL=https://spellglass.example.com/ npm run desktop:win` (in PowerShell, `$env:SPELLGLASS_WEB_URL = 'https://spellglass.example.com/'` first), or set it as a repository variable for the workflow. It must be an https address (`http://localhost` is accepted for testing); replay links made in the desktop app then open there.

How it fits together:

- `desktop/main.mjs` is Electron's main process, plain ESM with nothing to compile. It serves `dist/` at `app://spellglass/`, a privileged scheme (`desktop/protocol.mjs`), so the page is a secure context with an origin of its own: workers, WebAssembly, IndexedDB, `crypto.subtle` and the camera behave as they do over https. Each file gets its content type, a missing one a 404, and nothing outside `dist/` can be reached.
- `desktop/policy.mjs` holds the rules the main process applies. It refuses every request that is not to `app://spellglass/`, from any page or worker, whatever its own policy says (Section 11.2). It grants the camera, never the microphone (the desktop app has no voice), plus the clipboard write, durable storage and full screen that Chrome grants without asking, to the app alone, and refuses everything else (location, notifications, screen capture, devices). The window stays on the app: web links open in the system browser, the tip finder opens in a window of its own, and nothing else opens or navigates. The page runs with context isolation, the sandbox and no Node.js. There is no menu bar on Windows and the standard menus on a Mac, and the developer tools are off in a packaged app unless `SPELLGLASS_DEVTOOLS=1` is set.
- The page knows it is the desktop app from `location.protocol` (`src/main.ts`): it registers no service worker, leaves the speech API out, and words a few sentences for a computer rather than a browser tab.
- `electron-builder.config.mjs` packs only `package.json`, `desktop/*.mjs` and `dist/` (without source maps or `node_modules`) into an asar, sets Electron's fuses that cost nothing (no running as plain Node, no `NODE_OPTIONS`, only the asar is loaded), and names the files. `tools/desktop.mjs` runs the web build with the base path `/` first. `tools/make-splash.mjs` redraws `desktop/splash.bmp`, the picture the portable `.exe` shows while it unpacks.
- Two switches exist for the tests: `--spellglass-user-data=<dir>` (another user data folder) and `--spellglass-fake-camera[=<clip.y4m>]` (Chrome's fake camera).
- If Electron stops at once with `SyntaxError: The requested module 'electron' does not provide an export named 'BrowserWindow'` (or `Cannot find module 'electron'`), `ELECTRON_RUN_AS_NODE=1` is set in the environment (some editors set it), which starts Electron as plain Node. The npm scripts and the tests remove it, and the packaged app ignores it.

### Getting the files to players

The workflow's artifacts are for you, not for players: GitHub zips them, asks for a sign-in, and deletes them after 30 days. To hand Spellglass out, attach the files to a **GitHub Release**, which gives each one a plain download link, or put them anywhere players can download a file. Give each release a version of its own: raise `version` in `package.json` (the files are named after it), commit, then tag that commit and push the tag (`git tag v0.2.0`, `git push origin v0.2.0`), which builds it in the Desktop app workflow. Attach that run's files (Releases › Draft a new release, or `gh release create v0.2.0 Spellglass-0.2.0.exe Spellglass-0.2.0-mac.dmg ...`). Do not reuse `v0.1.0`, which points at the first version, and push the tag before running `gh release create`: a tag it makes itself comes from `main`. Players download `Spellglass-<version>.exe` (Windows) or the `.dmg` (Mac) and double-click it.

### Signing and notarizing, later

Unsigned apps meet the warnings above. To sign:

- **Windows:** a code-signing certificate, given to electron-builder as `CSC_LINK` (the .pfx file, or its base64) and `CSC_KEY_PASSWORD`, or Azure Trusted Signing through `win.azureSignOptions`. SmartScreen warns less as a signed app earns reputation.
- **macOS:** a Developer ID Application certificate as `CSC_LINK` and `CSC_KEY_PASSWORD`, and notarization with an App Store Connect API key in `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`. The app is already built with the hardened runtime. Unsigned, it is signed ad hoc with `desktop/entitlements.mac.adhoc.plist`; with a certificate given, the config signs with it and switches to `desktop/entitlements.mac.plist` (the camera and JIT, without the `disable-library-validation` that only ad hoc signing needs).
- Settle `appId` in `electron-builder.config.mjs` before the first signed release: Windows and macOS know the app by it.
- In the workflow, pass these as repository secrets to the packaging step.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Development server at http://localhost:5173 (it generates the pack validators first) |
| `npm run build` | Production build in `dist/` (installable, works offline; the hand model is cached on first use) |
| `npm run preview` | Serve the production build at http://localhost:4173 |
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
| `npm run models` | Downloads the hand-tracking model (7.5 MB) and copies its WebAssembly runtime into `public/models`, about 23 MB in all; "The tip of my wand" and "My hand or finger" need it |
| `npm run check` | Type checks, both lints and the tests (what CI runs) |
| `npm run desktop`, `desktop:win`, `desktop:mac`, `test:desktop` | The desktop app: open it, package it, test it (see [Desktop app](#desktop-app)) |

On Windows, run the tests through npm (or `node tools/run-vitest.mjs`): Vitest started from a shell that reports the drive letter in lower case loads twice and fails, and the wrapper fixes that. The test tools need Node 22.22.2 or a later 22, 24.15 or a later 24, or 26 and up (GitHub's builds use 24).

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
- A shared replay link carries only the cast itself: the traced shape and its timing, the spell, its grade and power, whether it was traced or spoken, and the prop it acted on. Clips leave your camera image out unless you tick "Include my camera".

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

Pushing to `main` runs `.github/workflows/deploy.yml`, which tests, downloads the hand model, builds with the base path `/<repository>/` and publishes to GitHub Pages. GitHub Pages has to be turned on for the repository first, with Settings › Pages › Source set to **GitHub Actions**, and `main` does not hold the app yet, so there is no hosted copy to play today. The desktop app has its own workflow, `.github/workflows/desktop.yml` (see [Desktop app](#desktop-app)).

Mind the origin. Browsers grant camera permission and keep IndexedDB and localStorage per origin, not per path. Served as a path of a domain that hosts other pages (`example.com/Spellglass/`), Spellglass shares all three with every page and script on that domain: once a player allows the camera, any of them can open it without asking, and any of them can read or delete the player's keepsakes, learned strokes and settings. The privacy promises of Section 11.2 then rest on everything else served there. An origin of its own avoids this: a subdomain such as `spellglass.example.com` set as the repository's Pages custom domain, with `BASE_PATH: /` in place of `/${{ github.event.repository.name }}/` in the build step of `.github/workflows/deploy.yml`.

## License

MIT for the code (see [LICENSE](LICENSE)). The hand-tracking runtime and its hand model (Google's MediaPipe), which `npm run models` fetches and the production build and the desktop app carry, are under the Apache License 2.0. The fonts are IM Fell English, IM Fell English SC, Cinzel Decorative and Spectral, under the SIL Open Font License.
