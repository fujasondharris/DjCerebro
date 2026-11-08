// Shared audio graph root: ONE AudioContext + master GainNode -> destination,
// used by both Deck A and Deck B so the crossfader can mix their output.
// Kept UI-free like the rest of src/lib/ (a future Claude "brain" milestone
// only ever talks to Deck/AudioCore, never to React).
const MASTER_HEADROOM_GAIN = 0.80; // ~-1.9 dB headroom before fast safety limiter + oversampled soft clipper

function buildSoftClipCurve(): Float32Array {
  const samples = 4096;
  const curve = new Float32Array(samples);
  const norm = Math.tanh(1.5);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    // Linear inside [-0.85, 0.85], smooth tanh ceiling above that so normal program
    // audio is 100% untouched and only rogue inter-sample transients are rounded.
    if (Math.abs(x) <= 0.85) {
      curve[i] = x;
    } else {
      const sign = x < 0 ? -1 : 1;
      const excess = (Math.abs(x) - 0.85) / 0.15;
      curve[i] = sign * (0.85 + 0.15 * (Math.tanh(excess * 1.5) / norm));
    }
  }
  return curve;
}

export class AudioCore {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private masterLimiter: DynamicsCompressorNode | null = null;
  private masterClipper: WaveShaperNode | null = null;

  private wireMasterToDestination(fadeIn = false): void {
    if (!this.context || !this.masterGain) return;
    const now = this.context.currentTime;
    this.masterGain.gain.value = MASTER_HEADROOM_GAIN;
    if (fadeIn) {
      try {
        this.masterGain.gain.setValueAtTime(0.0001, now);
        this.masterGain.gain.linearRampToValueAtTime(MASTER_HEADROOM_GAIN, now + 0.015);
      } catch {
        this.masterGain.gain.value = MASTER_HEADROOM_GAIN;
      }
    }
    if (!this.masterLimiter && typeof this.context.createDynamicsCompressor === "function") {
      try {
        const limiter = this.context.createDynamicsCompressor();
        limiter.threshold.value = -2.5; // fast peak ceiling below 0 dBFS
        limiter.knee.value = 0; // hard limiting knee catches drum transients cleanly
        limiter.ratio.value = 20; // true 20:1 brickwall limiting ratio
        limiter.attack.value = 0.003; // 3ms attack catches overlapping kick/snare transients
        limiter.release.value = 0.10; // 100ms release recovers cleanly between beats
        if (typeof this.context.createWaveShaper === "function") {
          const clipper = this.context.createWaveShaper();
          clipper.curve = buildSoftClipCurve() as Float32Array<ArrayBuffer>;
          clipper.oversample = "4x";
          limiter.connect(clipper);
          clipper.connect(this.context.destination);
          this.masterClipper = clipper;
        } else {
          limiter.connect(this.context.destination);
        }
        this.masterLimiter = limiter;
      } catch {
        this.masterLimiter = null;
        this.masterClipper = null;
      }
    }
    this.masterGain.connect(this.masterLimiter ?? this.context.destination);
  }

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
      this.wireMasterToDestination();
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

  /**
   * Hard-severs any orphaned or background AudioBufferSourceNodes (stems, loops,
   * rolls, or stingers) connected to the current master GainNode by muting and
   * disconnecting the old master GainNode, replacing it with a fresh GainNode
   * connected to destination, and invoking `reconnectDecks()` so only Deck A
   * and Deck B remain wired to the speakers.
   */
  purgeOrphanedNodes(reconnectDecks?: () => void): void {
    if (!this.context || !this.masterGain) return;
    const oldMaster = this.masterGain;
    const now = this.context.currentTime;
    try {
      const param = oldMaster.gain;
      if (typeof param.cancelAndHoldAtTime === "function") {
        param.cancelAndHoldAtTime(now);
      } else {
        const current = param.value;
        param.cancelScheduledValues(now);
        param.setValueAtTime(current, now);
      }
      param.linearRampToValueAtTime(0, now + 0.018);
      const disconnectTimer = setTimeout(() => {
        try {
          oldMaster.disconnect();
        } catch {
          // ignore already disconnected
        }
      }, 28);
      (disconnectTimer as unknown as { unref?: () => void }).unref?.();
    } catch {
      try {
        oldMaster.disconnect();
      } catch {
        // ignore
      }
    }
    this.masterGain = this.context.createGain();
    this.wireMasterToDestination(true);
    reconnectDecks?.();
  }
}
