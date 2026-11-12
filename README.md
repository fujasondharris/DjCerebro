# DJ Cerebro

A mobile-first browser AI DJ. The app is the always-on "body": two decks with pitch-preserving tempo sync (±8%), beat/phrase alignment off Serato BeatGrid tags, per-deck 3-band EQ with kills, HPF/LPF sweep filters, real FX sends (tempo-synced echo tails, reverb), one-shot stingers, scratch patterns, beat rolls, and six transition styles (beatmatched crossfade, bass swap, echo out, cut, loop-tension blend, clean gap). Claude is the on-call "brain": you chat vibe reads (or flip on autopilot), it answers with one JSON command — which track, which transition, which FX — and the app executes deterministically. It mixes like an open-format party DJ: starts tracks where the energy is (skipping long intros), exits before dead outros, fires transitions on phrase boundaries, avoids vocal-over-vocal clashes using lyric-derived vocal maps, follows Camelot key compatibility, and shapes the whole set toward a peak at ~62% of your chosen party length. A lesson ledger records your ratings, notes, and manual FX presses per-track, and feeds them back to the brain so it learns your taste.

Tracks come from your phone's file picker or a Google Drive crate folder (lazy-loaded: metadata first, full files on demand, cached in IndexedDB). BPM/key are read client-side from ID3 tags (Serato writes them). Architecture rule: the brain is never a real-time loop — the app always keeps playing on its own; Claude is only consulted at decision points.

The brain's on-mic persona is **El Cerebro** ("no hands, puro cerebro"). This is the shareable cut of a personal project originally built as *DJ Supermercado* — you'll see that name in the code and the brain's persona prompt; everything runs on your own keys and your own music, nothing is tied to the original deployment.

## What you need

Three accounts, all with free tiers that work fine:

1. **Claude (Anthropic)** — an API key from [console.anthropic.com](https://console.anthropic.com). This powers the brain. **Required** — without it the app still runs as a manual two-deck mixer, but there's no AI DJ.
2. **Google Drive** — a folder of your MP3s, shared "anyone with link". This is your crate. Optional but strongly recommended (the alternative is picking files by hand from your phone each time).
3. **Vercel** — [vercel.com](https://vercel.com), free Hobby tier. Only needed to put the app on the real internet (party Wi-Fi, phone on cell data). For home/LAN use you can skip it and run locally.

## The easy way: let Claude set it up

This repo ships with a [`CLAUDE.md`](CLAUDE.md) setup runbook. If you use [Claude Code](https://claude.com/claude-code):

```bash
git clone https://github.com/DjCerebro/DjCerebro.git
cd DjCerebro
claude
```

Then just say: **"set this up for me"**. Claude reads `CLAUDE.md` automatically and will walk you through the API key, the Drive crate, env vars, local run, and the Vercel deploy — asking you only for the things it can't do itself (logins, key creation).

## The manual way

1. **Clone and install:**
   ```bash
   git clone https://github.com/DjCerebro/DjCerebro.git
   cd DjCerebro
   npm install
   ```
2. **Env vars:** `cp .env.local.example .env.local` (Windows: `copy`), then
   fill in your own values — every var is documented inline in that file.
   - `ANTHROPIC_API_KEY` (required) — powers the brain (`/api/dj`); without
     it the app still runs, the brain just 500s.
   - `ANTHROPIC_MODEL` (optional) — defaults to `claude-opus-5`.
   - `DJ_PASSCODE` (optional) — pick your own passcode to gate the site at
     the edge and every API route. Leave blank for local dev, set it before
     deploying so your URL isn't wide open.
   - Google Drive crate (optional) — create a Drive folder, share it "anyone
     with link", upload your own tagged MP3s, and set `GOOGLE_DRIVE_FOLDER_ID`
     to its id (the long string in the folder's URL). Add `GOOGLE_API_KEY`
     (a Drive v3 API key, no OAuth) for live folder listing; with no key the
     app falls back to the committed `src/data/crate-manifest.json` (empty
     in this repo — regenerate it with `npm run make:crate-manifest`).
3. **Run it:**
   ```bash
   npm run dev
   ```
   Or on your phone (same Wi-Fi): `npm run dev -- -H 0.0.0.0`, then visit
   your computer's LAN IP (e.g. `http://10.0.5.10:3000` — `ipconfig` /
   `ifconfig` shows yours).
4. **Deploy to your own Vercel account:**
   ```bash
   vercel login
   vercel --prod
   ```
   Then, in **your** Vercel project's Settings → Environment Variables, set
   the same vars as `.env.local` (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`,
   `DJ_PASSCODE`, `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_API_KEY`) and redeploy.
   The crate-download route (`src/app/api/crate/[id]/route.ts`) runs on
   Vercel's **Edge runtime** on purpose (Node serverless functions cap
   response bodies around 4.5MB on the Hobby plan, which breaks full-track
   downloads) — the free Hobby tier supports Edge functions, so no paid plan
   is required. Any other Node host that runs `next start` also works, except
   watch for that same response-size limit if your host imposes one on plain
   Node routes.
   - Optional: create a **Vercel Blob** store and connect it to the project
     (Storage tab → Blob → Connect; this sets `BLOB_READ_WRITE_TOKEN`
     automatically). That enables `/api/lessons` — cross-device sync of the
     lesson ledger, so ratings you enter on your phone reach the brain from
     any device. Without it the ledger still works per-device (localStorage).
5. **Your own crate library (optional, only if you want the extras):**
   - `npm run make:crate-manifest` — regenerates `src/data/crate-manifest.json`
     (the keyless-fallback track listing, with BPM/key tags embedded when the
     matching MP3s are on disk). With `GOOGLE_API_KEY` set you can skip it —
     live Drive listing doesn't need the manifest.
   - `npm run build:vocal-maps` — regenerates `src/data/vocal-maps.json`
     (lyric-derived vocal intervals used for clash-free transition timing).
   - `npm run suggest:cues` — regenerates `src/data/cue-suggestions.json`
     (suggested cue points from synced lyrics).

## Known iOS Safari caveats

- The tab must stay in the foreground/unlocked — backgrounding Safari (or letting the screen lock) suspends the AudioContext and stops playback. The app requests a Screen Wake Lock while playing to help keep the screen from locking, but this is best-effort and unsupported on older iOS versions.
- The very first tap on Play is what creates/unlocks the AudioContext (iOS's autoplay restriction). Loading a file does not start audio by itself — you always need one tap on Play before you'll hear anything.
- Picking a file via "Load MP3" opens the native iOS file picker (Files app / Photos-style sheet), which some iOS versions restrict for audio files depending on where the MP3 lives (Files app, iCloud Drive, a shared AirDrop, etc.) — if the picker looks empty, save the MP3 into the on-device Files app first.

## What's in here

- `src/app/page.tsx` — the single-page UI: deck panels, crossfader, FX pad, crate, brain chat/autopilot, cue rehearsal, lessons panel — plus the autopilot loop and command execution.
- `src/app/api/dj/route.ts` — the brain endpoint: Anthropic API call with 1h-TTL prompt caching, zod-validated JSON command out, per-call cost reporting.
- `src/app/api/crate/…` — Google Drive crate listing + file proxy (Edge runtime for full-track downloads).
- `src/app/api/lessons/route.ts` — optional cross-device lesson-ledger sync (Vercel Blob).
- `src/lib/` — UI-free engine modules, each with a matching pure check script under `scripts/`: `audio-core` (shared AudioContext), `deck` (per-deck graph: PitchShifter → EQ → sweep filters → gain, plus FX sends), `beatmatch`/`beatclock`/`phrase` (sync + phase + phrase math), `serato` (BeatGrid reader), `id3` (zero-dep TBPM/TKEY reader), `transition` (all six transition kinds), `fx`/`fx-sends`/`scratch`/`roll`/`loop-blend` (stingers, sends, overlays), `energy` (mix-in/mix-out detection), `vocal-map` (lyric-derived vocal intervals + clash-minimizing transition timing), `camelot` (key wheel), `brain` (command schema + system prompt), `lesson-ledger`/`lessons`/`history-store` (the learning loop), `cue-store`, `pricing`, `crate`, `passcode`.
- `scripts/check-*.mjs` — ~30 dependency-free assertion suites covering every pure module (`npm run check:<name>`).
- `scripts/build-vocal-maps.mjs` / `suggest-cues.mjs` — crate-prep pipelines (synced lyrics → vocal maps / suggested cue points).
- `public/sfx/` — licensed one-shot recordings (provenance in `LICENSES.txt`); `public/fixtures/` — tagged test tones for the check suites.
