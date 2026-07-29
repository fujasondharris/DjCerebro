// soundtouchjs ships as plain ES2015 JS with no bundled types.
// Surface matches node_modules/soundtouchjs/dist/soundtouch.js (v0.3.0).
declare module "soundtouchjs" {
  export interface PitchShifterPlayDetail {
    timePlayed: number;
    formattedTimePlayed: string;
    percentagePlayed: number;
  }

  export class PitchShifter {
    constructor(context: AudioContext, buffer: AudioBuffer, bufferSize?: number, onEnd?: () => void);

    readonly formattedDuration: string;
    readonly formattedTimePlayed: string;
    readonly node: AudioNode;

    duration: number;
    percentagePlayed: number;
    pitch: number;
    pitchSemitones: number;
    rate: number;
    tempo: number;

    connect(toNode: AudioNode): void;
    disconnect(): void;
    on(eventName: "play", callback: (detail: PitchShifterPlayDetail) => void): void;
    off(eventName?: string | null): void;
  }
}
