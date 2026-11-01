// Public IDs only. Credentials and provider transports never enter the browser.
export const BRAIN_MODELS = [
  { id: "claude", label: "Claude · Opus 5", model: "claude-opus-5" },
  { id: "gemini", label: "Antigravity · Gemini 3.8", model: "gemini-3.8-flash" },
  { id: "grok", label: "Grok · 4.7", model: "grok-4.7" },
  { id: "openai", label: "OpenAI · GPT-6.1 Sol", model: "gpt-6.1-sol" },
  { id: "muse", label: "Muse · Spark 1.3", model: "muse-spark-1.3" },
] as const;
export type BrainModelId = typeof BRAIN_MODELS[number]["id"];
export interface BrainModelOption { id: BrainModelId; label: string; model: string; available: boolean }
export const BRAIN_MODEL_STORAGE_KEY = "djsm.brain-model";
export function isBrainModelId(value: unknown): value is BrainModelId {
  return BRAIN_MODELS.some(option => option.id === value);
}
