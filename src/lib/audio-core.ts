// Shared audio graph root: ONE AudioContext + master GainNode -> destination,
// used by both Deck A and Deck B so the crossfader can mix their output.
// Kept UI-free like the rest of src/lib/ (a future Claude "brain" milestone
// only ever talks to Deck/AudioCore, never to React).
export class AudioCore {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  /**
   * Creates the AudioContext (and master gain) on first call, resumes it if
   * suspended. MUST be called synchronously from inside a user gesture
   * handler (tap/click) — iOS Safari will not let a context produce sound
   * otherwise ("autoplay" restriction extends to any first-use context).
   * Safe to call from either deck; only the first call actually constructs
   * anything.
   */
  ensureContext(): AudioContext {
    if (!this.context) {
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.context = new AudioContextCtor();
      this.masterGain = this.context.createGain();
      this.masterGain.connect(this.context.destination);
    } else if (this.context.state === "suspended") {
      void this.context.resume();
    }
    return this.context;
  }

  /** The node every deck's own gain feeds into. Only valid after ensureContext(). */
  get master(): GainNode {
    if (!this.masterGain) {
      throw new Error("AudioCore.master read before ensureContext() was called");
    }
    return this.masterGain;
  }

  /**
   * Resumes the AudioContext if one exists and is currently suspended (e.g.
   * the OS/browser suspended it while the tab was backgrounded — separate
   * from the Screen Wake Lock, which the browser also releases on
   * backgrounding but which only stops the screen from sleeping, not the
   * audio graph). No-ops safely if ensureContext() has never been called
   * yet (nothing to resume). Returns true only when a resume was actually
   * triggered, so a caller can log a "recovered" line rather than one on
   * every foreground return regardless of whether anything was wrong.
   */
  resumeIfSuspended(): boolean {
    if (this.context && this.context.state === "suspended") {
      void this.context.resume();
      return true;
    }
    return false;
  }
}
