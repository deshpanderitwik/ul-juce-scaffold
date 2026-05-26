# Distribution & Update Architecture

A design for keeping two installed copies of the plugin (yours and your
collaborator's) in sync with new experiments and, less often, with new
versions of the underlying VST.

This is a decision document, not an implementation. Read it through, mark
it up, and let me know which pieces to build.

---

## 1. Goal

- Install the VST3 once per laptop.
- Push **experiment changes** (new files in `web/`, edits to existing ones)
  to both laptops as soon as they happen, ideally automatically and ideally
  without a DAW restart.
- Push **VST changes** (anything in `src/*.cpp|h`, CMakeLists, JUCE upgrades)
  occasionally and deliberately, accepting that this is a heavier flow.
- Keep the operating model simple enough that two people can use it without
  ceremony.

---

## 2. The fact that drives the design

You have **two layers with completely different update physics.**

| | Experiment layer | VST layer |
|---|---|---|
| What | `web/*.js`, `index.html`, three.min.js, etc. | Compiled `.vst3` bundle |
| Substrate | Text/assets loaded by the embedded WebView | Native binary loaded into the DAW process |
| Per-platform? | No (pure JS) | Yes — separate macOS / Windows builds |
| Code signing? | No | Yes on macOS (notarization), recommended on Windows |
| Hot-reload? | Yes (re-navigate the WebView) | No (DAW restart) |
| Currently updates remotely? | **No** — baked into `BinaryData` at build time | **No** — requires reinstall |

The right strategy is to lean **all the way** into this asymmetry: make
the experiment layer continuously / automatically synced, and accept
that the VST layer is a versioned, manual-ish release flow that you do
rarely.

---

## 3. Current state — what blocks remote updates today

From a read of the repo:

- **`PluginEditor.cpp:82-133`** — the resource provider. In `JUCE_DEBUG`
  it reads live from `web/` next to the source file; otherwise it falls
  back to `BinaryData` (compiled-in). There is no concept of a
  user-writable content directory.
- **`CMakeLists.txt:48-53`** — `juce_add_binary_data` globs `web/*.js`
  and `index.html` into `BinaryData` at build time. To change the JS,
  today you must rebuild.
- **`CMakeLists.txt:84`** — `JUCE_USE_CURL=0`. The C++ side has **no
  networking**. Any C++-side fetching needs this enabled (or platform
  native HTTP via `juce::URL`).
- **`PluginEditor.cpp:151`** — the WebView navigates to the resource
  provider root, not a remote URL. The page lives entirely "inside" the
  plugin via the resource-provider sandbox.
- **`.cursorrules:124`** — "Never modify the C++ layer unless explicitly
  asked." This rule is consistent with the design proposed here: the
  C++ layer becomes a stable host and rarely changes.

---

## 4. Proposed architecture (one-paragraph summary)

The VST binary becomes a **stable, generic host** — WebView + MIDI bridge +
transport + a writable "content directory" on disk. The resource provider
reads experiments from that content directory first, falling back to the
`BinaryData` baseline shipped with the binary. The content directory is
kept in sync between laptops by whatever mechanism is most convenient
(cloud folder, git pull, or HTTP fetch). The VST binary itself is rebuilt
and reinstalled only when the C++ bridge actually changes, which the
existing scaffold philosophy says should be rare.

```
                          ┌──── content dir (user-writable) ────┐
                          │   ~/.../JuceScaffold/web/           │
                          │     shell.js, *.js, index.html      │
                          │       ↑ kept in sync by             │
                          │       (cloud / git / fetch)         │
DAW ─► VST3 (stable) ─► WebView ─► resource provider             │
        │                          │  1. check content dir       │
        │                          │  2. fall back to BinaryData │
        ▼                          └─────────────────────────────┘
       MIDI out
```

---

## 5. Experiment layer — design

### 5.1 The C++ change (one-time, small)

Extend the existing resource provider to check a writable directory on
disk before falling back to `BinaryData`. Concretely:

- Pick a platform-appropriate path. JUCE has
  `juce::File::getSpecialLocation(userApplicationDataDirectory)` →
  `~/Library/Application Support/JuceScaffold/web/` on macOS,
  `%APPDATA%\JuceScaffold\web\` on Windows.
- On first launch, if the content dir is empty, the plugin can write the
  baseline (extracted from `BinaryData`) into it so the user has a
  starting point to edit / replace.
- In the resource provider: check the content dir, then `BinaryData`.
  Keep the `JUCE_DEBUG` path that reads from `web/` next to the source.
- Add a "Reload" affordance — either a keystroke, a button in the JS
  shell, or both — that calls `browser.goToURL(getResourceProviderRoot())`
  again. That's a full re-fetch of the experiment code with no DAW
  restart.

This is a small change to `PluginEditor.cpp` and a one-time bump to the
VST version. After this, the C++ side never needs to know how experiments
got into the content dir.

### 5.2 Delivery options for the content directory

Once the plugin reads from a real folder, "pushing an update" becomes
"getting bytes into that folder on both laptops." Options ordered by
setup cost:

#### Option A — Shared cloud folder (Dropbox / iCloud / Drive)

The content dir **is** a symlink/junction to a shared folder.

- Pros: zero infrastructure, works offline (sync client caches), updates
  appear within seconds, no plugin changes beyond §5.1, friendly to
  non-developers.
- Cons: cloud client must be installed and running; symlinks behave
  slightly differently on macOS/Windows; conflict files can appear if
  you both edit the same file at the same moment.
- Best for: two-person workflows where one person is editing and the
  other is mostly receiving.

#### Option B — Git pull from this repo

The content dir is a `git clone` of this repo (or just the `web/`
subtree). A "sync" button in the plugin, or a launchd / Task Scheduler
job, runs `git -C <dir> pull` on a schedule or on plugin launch.

- Pros: real version control (you already have it), atomic, easy to
  roll back, no extra service.
- Cons: needs git installed and credentials configured; a background
  pull on every launch can stall startup if the network is slow; merge
  conflicts if both laptops edit independently.
- Best for: developer-only workflows where you want full history and
  branching.

#### Option C — Runtime HTTP fetch (most C++-free)

Don't bother with a content dir on disk. Host `web/` on GitHub Pages or
a tiny static bucket. `shell.js` (or `index.html`) fetches experiments
from a remote URL and `import()`s them dynamically.

- Pros: zero additional C++ changes, instant updates, no cloud client,
  no git CLI. Each laptop always runs the latest.
- Cons: needs network on plugin launch; offline = stale or broken unless
  you implement a local cache layer; you're `eval`/importing remote code
  so the host must be trusted (your own GitHub Pages is fine for two
  collaborators).
- Best for: prototyping speed when you don't mind being online.

#### Option D — Self-updater with a version manifest

Plugin reads a JSON manifest (e.g. `https://.../manifest.json`) listing
file names + hashes + a bundle version. On launch (or on demand) it
downloads any changed files into the content dir and reloads the WebView.

- Pros: explicit version control, can show "new experiments available"
  UI, supports rollback, gives you a place to ship release notes.
- Cons: most code to write. Needs networking on the C++ side
  (`JUCE_USE_CURL=1` or `juce::URL`) **or** can be done entirely in JS.
- Best for: when this stops being two people and starts being a small
  group.

### 5.3 Reload semantics

All four options can apply **without a DAW restart**:

- The WebView is owned by the editor, not the processor. Re-navigating
  it reloads the page from the resource provider, which now reads the
  fresh content dir.
- A "Reload" button in `shell.js` calling `location.reload()` works for
  the experiment code itself.
- For changes to `index.html` or the script-loading order, re-call
  `browser.goToURL(...)` from C++. A small `nativeIntegration` listener
  for a JS-side `reload` event takes one line.

This means **the loop is "save file → it syncs → press Reload → it's
running"**, with no DAW interaction.

### 5.4 Recommendation for the experiment layer

**Combine A and the §5.1 content directory.** Put the content dir on
Dropbox/iCloud. Add a Reload button to the shell. That's the lowest-effort
setup that handles offline, requires no auth, and gives you near-instant
push to both laptops. Keep Option C in mind for when you want to do a
weekend prototype without setting up the cloud folder on a new machine.

The §5.1 C++ change is also a one-time prerequisite for B and D, so it's
not wasted if you change delivery later.

---

## 6. VST layer — design

The VST layer is fundamentally heavier and we shouldn't pretend otherwise.

### 6.1 What forces a VST update

Only changes to `src/*.cpp|h`, `CMakeLists.txt`, the JUCE version, the
binary data baseline (if you want a new fallback shipped), or platform
SDK requirements. If you do §6.5 well, this is rare.

### 6.2 Building per platform

You and your collaborator are presumably on macOS or Windows; one or
both. The realistic options:

#### Option α — GitHub Actions matrix build (recommended)

On a tag like `v0.2.0`, GitHub Actions builds the `.vst3` on
`macos-latest` and `windows-latest`, signs them (see §6.4), and attaches
them to a GitHub Release.

- Pros: reproducible builds; both laptops fetch from the same source;
  you can review and roll back; nobody has to build locally.
- Cons: one-time CI setup; signing requires storing certificates as CI
  secrets.

#### Option β — Build locally, share via cloud folder

You build on your laptop, drop the `.vst3` in a shared folder, the
collaborator copies it into their plugin directory.

- Pros: no CI to set up.
- Cons: you can only build for your own OS; signing has to happen on
  your machine; manual.
- Best for: very early, both-on-same-OS, "I'll just send it" workflow.

### 6.3 Applying the update on the receiving laptop

Three options:

1. **Installer** (`.pkg` on macOS, `.exe` on Windows). Re-run to update.
   Most robust, least magical.
2. **Manual copy** — drop the new `.vst3` into the plugin folder. Works
   on macOS because bundles aren't locked; on Windows the DAW may need
   to be closed first.
3. **Updater script / companion app** — a small helper that polls the
   GitHub Releases API, downloads the artifact, and copies it into
   place. Restart the DAW to apply.

The DAW restart is **unavoidable** — even if the file is replaced, the
loaded code stays in the host's process until it unloads the plugin.

### 6.4 Code signing & notarization

- **macOS:** required if you want the plugin to load without Gatekeeper
  warnings. Needs an Apple Developer account (\$99/yr) and
  `codesign` + `notarytool` in CI. Without it, you'll see "cannot be
  opened because the developer cannot be verified" the first time on
  each laptop. Workaround: right-click → Open, once, per binary version.
- **Windows:** not strictly required for VSTs (no SmartScreen for plugin
  bundles in the way), but a code-signing cert is nice to have if you
  ever ship more broadly.

For a two-person setup, you can probably skip notarization for now and
live with the right-click-Open step on first install of each version.

### 6.5 How to make this layer rarely change

This is the most important point in the whole document. The scaffold
philosophy in `.cursorrules` already says "never modify the C++ layer
unless explicitly asked" — but to make that real, the C++ side has to
expose enough capability up front that experiments don't keep needing
new bridge functions.

Things worth considering shipping in the C++ host **now** so you don't
have to ship new VST binaries later:

- A generic `sendToHost(channel, payload)` / `onHostMessage(channel,
  callback)` pair on top of the existing `nativeIntegration` listeners,
  so new commands can be added without C++ changes (the C++ side just
  routes typed messages by channel name).
- All-channels MIDI (CC, pitch bend, program change, channel pressure,
  poly aftertouch) — not just note on/off. Each one not present today
  is a future forced VST update.
- A "host capabilities" object the JS can query (`window.HostCaps`)
  exposing version, supported message channels, platform. Then `shell.js`
  can gracefully degrade if it's running on an older VST and the user
  hasn't updated yet.
- Persisted state — give JS a way to store small blobs (per-experiment
  presets, last-key-and-scale) that survive plugin reloads. Without
  this, every experiment that wants persistence will eventually push
  you toward changing the C++.
- File-system access for `web/`-loaded experiments, scoped to a known
  user directory (samples, custom assets).

The work here is one focused VST release. After that, the C++ side can
plausibly stay frozen for months.

### 6.6 Recommendation for the VST layer

**GitHub Actions release builds (α) + manual install for now (skip
notarization).** Tag a release, CI builds both platforms, you each
download the artifact for your OS and drop it in the plugin folder,
restart the DAW. Add an installer later if it gets annoying. Add an
updater script later if you want full automation. Invest the first
release in §6.5 capability work so future releases get rarer.

---

## 7. Versioning & rollback

- **Experiment layer:** the content dir is a git checkout (or the cloud
  folder maps to one). Rolling back is `git checkout <sha>` or the
  cloud's file-history UI.
- **VST layer:** semver tags on the repo, attached `.vst3` artifacts on
  the GitHub Release. To roll back, download the older artifact and
  reinstall. Keep at least one release back installed locally if you're
  in a risky stretch.
- **Combined:** the `shell.js` `HostCaps` object means experiments can
  detect "I need VST ≥ 0.3 features" and refuse to run on older hosts
  with a clear message instead of breaking obscurely.

---

## 8. Concrete minimum-viable setup (what I'd build first)

If you want one walkable path forward, here's the smallest thing that
delivers the full value proposition:

1. **One C++ change**: resource provider checks
   `userApplicationDataDirectory/JuceScaffold/web/` before `BinaryData`.
   First-launch seeds it from `BinaryData`. Add a `reloadWeb` native
   integration listener so JS can trigger a re-navigate.
2. **One shell change**: a "Reload" button (or `R` keystroke) that fires
   `reloadWeb`. Optional: a small banner showing the content dir path.
3. **Sync the content dir** via Dropbox/iCloud (symlink the directory
   to a shared folder), one-time setup per laptop.
4. **GitHub Actions workflow** that builds `.vst3` for macOS and Windows
   on tag push, attaches them to a release. Used the first time you
   actually need a new VST.
5. **One small C++ capability pass** (the things in §6.5) so the next
   VST release is far away.

After this, the workflow is:

- Editing an experiment → save the file → it syncs → both laptops press
  Reload. No DAW restart, no rebuild.
- Updating the VST → tag a release → CI builds → both laptops grab the
  artifact for their OS → restart the DAW.

---

## 9. Open questions for you

These will change the recommendation; worth deciding before any code:

1. **Are both laptops the same OS?** If both are macOS, the VST story
   is half as much work (no Windows build, one signing flow).
2. **How important is offline?** If "the plugin must always work even
   on a plane" is a hard requirement, Option C (runtime fetch) is out
   and we want a local cache.
3. **Is your collaborator a developer?** If yes, git-based delivery (B)
   is fine. If not, the cloud folder (A) is much friendlier.
4. **Do you want the plugin itself to show "update available" UI**, or
   is "I'll tell you when to grab a new build" fine for the VST layer?
5. **Do you want notarized macOS builds**, or is right-click-Open per
   version acceptable for now?
6. **Should experiment changes from your laptop reach the collaborator
   automatically**, or do you want a "publish" step (push to main, tag,
   etc.) between editing and them seeing it?

---

## 10. Suggested sequencing

Once you've answered §9, the order I'd build in:

1. C++ resource-provider change + content-dir seeding (small, isolated).
2. Reload mechanism (JS button + native integration listener).
3. Pick a delivery option for the content dir and wire it up (often
   nothing more than "symlink this folder").
4. C++ capability pass (§6.5) — fold it into the same VST release as
   step 1 to minimize the number of forced reinstalls.
5. GitHub Actions release workflow for the VST binary.
6. (Later, if needed) self-updater UI, notarization, installer, version
   manifest.

Each step is independently useful and the order avoids forcing a second
VST reinstall right after the first.
