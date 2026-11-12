#!/usr/bin/env node
// M7 Phase 5 — generates one El Cerebro voice tag with the standing TTS spec,
// so the recipe lives in code rather than only in dj-tools\tags\README.txt.
//
// Spec (README.txt, "tag2-* — brand announcer tags", 2026-07-26):
//   OpenAI gpt-4o-mini-tts, response_format mp3, voice "ash", ANNOUNCER_STYLE
//   instructions, then ffmpeg: atempo (tempo only, pitch untouched), silence
//   trimmed off both ends, loudnorm.
//
// BRAND WALL (standing rule): "DJ Cerebro" / "El Cerebro" is his own name and
// is fine. "DJ Supermercado" and "Los Descuentos" are reserved external DJ brand names and
// must never come out of El Cerebro's mouth — enforced here as a hard refusal
// before any network call, not merely as a convention.
//
// Usage:
//   node --experimental-strip-types scripts/make-voice-tag.mjs \
//     --text "¡DJ Cerebro! ¡No pare la fiesta!" \
//     --out "C:\\Users\\Shadow\\dj-tools\\tags\\tag2-nopare.mp3" [--atempo 1.15]
//
// Key: OPENAI_API_KEY from the environment or .env.local, else the path in
// OPENAI_KEY_FILE (default: Desktop\AIToolbox\openaikey.txt). Never logged.
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const VOICE = "ash";
const MODEL = "gpt-4o-mini-tts";
const DEFAULT_ATEMPO = 1.15;
const ANNOUNCER_STYLE =
  "Over-the-top Latin party DJ drop announcer. Shout with maximum hype " +
  "energy, Spanish accent, rolled R's, like a reggaeton radio DJ voice tag " +
  "echoing over a packed club. Fast, punchy, larger than life.";

/** Reserved external brand names, never to El Cerebro. Checked case/accent-insensitively. */
const BRAND_WALL_FORBIDDEN = ["dj supermercado", "supermercado", "los descuentos", "descuentos"];

function loadEnvLocal() {
  try {
    const raw = readFileSync(path.join(REPO_ROOT, ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // no .env.local — real env vars may already be set
  }
}

/** Exported shape so scripts/check-voice-tag.mjs can verify the wall without a network call. */
export function violatesBrandWall(text) {
  const normalized = (text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return BRAND_WALL_FORBIDDEN.some((needle) => normalized.includes(needle));
}

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) return process.argv[idx + 1];
  return fallback;
}

function resolveApiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY.trim();
  const keyFile =
    process.env.OPENAI_KEY_FILE ||
    path.join(process.env.USERPROFILE ?? REPO_ROOT, "Desktop", "AIToolbox", "openaikey.txt");
  try {
    return readFileSync(keyFile, "utf8").trim();
  } catch {
    return null;
  }
}

async function main() {
  loadEnvLocal();

  const text = arg("text");
  const out = arg("out");
  const atempo = Number.parseFloat(arg("atempo", String(DEFAULT_ATEMPO)));

  if (!text || !out) {
    console.error('Usage: make-voice-tag.mjs --text "¡...!" --out <path.mp3> [--atempo 1.15]');
    process.exit(2);
  }
  if (violatesBrandWall(text)) {
    console.error(
      `REFUSED: "${text}" contains a reserved external DJ brand name ("DJ Supermercado" / "Los Descuentos"). ` +
        "El Cerebro never says these — see the brand-wall rule in dj-tools\\tags\\README.txt."
    );
    process.exit(1);
  }
  if (!Number.isFinite(atempo) || atempo < 0.5 || atempo > 2) {
    console.error(`REFUSED: atempo ${atempo} is outside ffmpeg's single-filter range [0.5, 2].`);
    process.exit(2);
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      "No OpenAI key. Set OPENAI_API_KEY, or OPENAI_KEY_FILE to a file containing it " +
        "(default: Desktop\\AIToolbox\\openaikey.txt)."
    );
    process.exit(1);
  }

  console.log(`  model ${MODEL}, voice ${VOICE}, atempo ${atempo}`);
  console.log(`  text: ${text}`);

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      voice: VOICE,
      input: text,
      instructions: ANNOUNCER_STYLE,
      response_format: "mp3",
    }),
  });
  if (!res.ok) {
    // Deliberately does not echo the body wholesale — it can contain the
    // request, and there's no reason to widen what gets printed.
    console.error(`TTS request failed: HTTP ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const rawPath = `${out}.raw.mp3`;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(rawPath, Buffer.from(await res.arrayBuffer()));

  // atempo (tempo only, pitch untouched) -> trim silence both ends -> loudnorm.
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      rawPath,
      "-filter:a",
      `atempo=${atempo},silenceremove=start_periods=1:start_silence=0.02:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_silence=0.02:start_threshold=-50dB,areverse,loudnorm`,
      out,
    ],
    { stdio: "inherit" }
  );
  if (existsSync(rawPath)) unlinkSync(rawPath);

  console.log(`  wrote ${out}`);
}

// Only run when invoked directly — importing this for the brand-wall check
// must not fire a network call.
if (process.argv[1] && process.argv[1].endsWith("make-voice-tag.mjs")) {
  main().catch((err) => {
    console.error(`FAILED: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
