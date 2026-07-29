# CLAUDE.md — setup runbook

You (Claude) are the setup assistant for this repo. When the owner says
"set this up", "get this running", or anything similar, walk them through
this runbook top to bottom. Do every step you can yourself (commands, file
edits, verification); ask the owner only for the things that need their
browser or their accounts (logins, key creation, folder sharing). Tell them
what you're doing as you go, and verify each step before moving on.

## What this app is (30-second orientation)

A browser AI DJ. The Next.js app is the always-on "body" (two decks, Web
Audio engine, deterministic mixing). Claude — called via the owner's
Anthropic API key on `/api/dj` — is the on-call "brain": one JSON command
per consult (which track, which transition, which FX). Never a real-time
loop. Music comes from the owner's Google Drive folder ("the crate") or the
phone's file picker.

## What the owner needs (collect these up front)

| Thing | Where | Required? |
|---|---|---|
| Anthropic API key | console.anthropic.com → API keys | **Yes** — it's the brain |
| Google Drive folder of MP3s, shared "anyone with link" | drive.google.com | Recommended — it's the crate |
| Google API key with Drive API enabled | console.cloud.google.com | Optional — live crate listing (skip = manifest fallback) |
| Vercel account | vercel.com (free Hobby) | Only for internet deploy; skip for LAN-only |

Ask which of these they already have before starting, and branch accordingly.

## Step 1 — install and smoke-test

```bash
npm install
npm run check:all   # ~30 dependency-free assertion suites; should all pass
npm run build       # must compile clean
```

Report failures to the owner before continuing.

## Step 2 — env vars

Copy `.env.local.example` to `.env.local` (it is gitignored — never commit
it) and fill in, asking the owner for each value:

- `ANTHROPIC_API_KEY` — required. If they don't have one, send them to
  https://console.anthropic.com → API keys → Create Key, and wait.
- `ANTHROPIC_MODEL` — leave blank (defaults to `claude-opus-5`). A cheaper
  option is `claude-sonnet-5` if they ask about cost.
- `DJ_PASSCODE` — leave blank for local dev. Before any real deploy, have
  the owner pick one — the app is gated site-wide at the edge when set.
- `GOOGLE_DRIVE_FOLDER_ID` — from the crate folder's URL
  (`drive.google.com/drive/folders/<THIS PART>`). The folder must be shared
  **"anyone with link"** or downloads will fail even with a valid API key.
- `GOOGLE_API_KEY` — optional. Google Cloud Console → create/select a
  project → enable **Google Drive API** → Credentials → API key. Suggest
  restricting the key to the Drive API. No OAuth needed (read-only, public
  folder).

## Step 3 — run locally and verify

```bash
npm run dev
```

Verify: `http://localhost:3000` loads; with a crate configured, "Add all
from Drive" lists tracks; loading a track and pressing Play produces audio
(remind them: the FIRST tap on Play is what unlocks audio — iOS especially).
Brain check: send a chat message; a JSON command + cost readout should come
back. If `/api/dj` 500s, the Anthropic key is missing/wrong.

For phone-on-same-WiFi testing: `npm run dev -- -H 0.0.0.0`, then the
computer's LAN IP on port 3000 from the phone.

## Step 4 — deploy to Vercel (only if they want it on the internet)

1. Owner runs `vercel login` (interactive — they must do this themselves).
2. `vercel --prod` from the repo root, accepting defaults (new project).
3. Set the same env vars on the Vercel project (Settings → Environment
   Variables → Production), then redeploy (`vercel --prod` again) — env
   changes do NOT apply to already-built deployments.
   - **Windows/PowerShell gotcha:** never pipe a value into
     `vercel env add` (`"x" | vercel env add ...` appends a trailing `\r`
     that silently corrupts the value). Write the value to a temp file and
     use `cmd /c "vercel env add NAME production < file"`, or paste it in
     the dashboard instead.
4. Insist on `DJ_PASSCODE` being set in production — without it the owner's
   Anthropic key is spendable by anyone who finds the URL.
5. Optional, for cross-device lesson sync: Vercel dashboard → Storage →
   Blob → create a store and **Connect** it to the project (that sets
   `BLOB_READ_WRITE_TOKEN` automatically), then redeploy.

Verify the deploy: the production URL should return the passcode gate page
(when gated); `<url>/?pass=<passcode>` should unlock it (cookie `dj_pass`);
a brain chat round-trip should work; queue a Drive track end-to-end — the
full file must download through `/api/crate/<id>` (this route is Edge
runtime on purpose; Node serverless caps bodies ~4.5MB on Hobby).

## Step 5 — crate quality (optional, big payoff)

- Tracks mix best with Serato-written ID3 tags (TBPM/TKEY + BeatGrid).
  Untagged tracks still play, but transitions fall back to plain cuts.
- After the crate changes (new uploads), regenerate the committed data:
  `npm run make:crate-manifest` (keyless fallback listing + embedded tags;
  matches Drive names against local MP3s if present), and optionally
  `npm run build:vocal-maps` + `npm run suggest:cues` (synced-lyrics-derived
  vocal maps and cue suggestions). Commit the regenerated JSON and redeploy.

## Troubleshooting quick hits

- **Every Drive download 502s mid-party:** Google per-IP abuse throttling —
  usually caused by burst tag-probing. Regenerate the crate manifest with
  tags embedded (`npm run make:crate-manifest`) so probes are skipped.
- **`vercel env pull` shows empty values:** Vercel REDACTS sensitive values
  on pull. An empty pull is NOT evidence the var is unset — check the
  dashboard.
- **No sound on iOS:** foreground the tab and tap Play once (AudioContext
  unlock). Backgrounding/locking suspends audio.
- **Brain works locally, 500s deployed:** env var missing on Vercel prod or
  set after the last build — set it and redeploy.
- **Crate lists but downloads fail:** folder not shared "anyone with link".

## House rules for working in this repo

- Engine modules in `src/lib/` are UI-free and each has a matching
  dependency-free check script in `scripts/` — extend the checks when you
  change an engine module, and run `npm run build` plus the relevant
  `check:*` before calling any change done.
- The brain is never put in a real-time loop; it returns one JSON command
  per consult and the app executes deterministically.
- Never commit `.env.local`, API keys, or the owner's passcode. The
  passcode may be referenced only as `DJ_PASSCODE`.
