export class LocalMediaPlayer {
  constructor(audio, volume = 20) {
    this.audio = audio;
    this.url = null;
    this.volume = volume;
    this.audio.volume = volume / 100;
  }
  select(file) {
    if (!file || !file.type.startsWith("audio/")) throw new Error("Choose a supported local audio file.");
    if (this.url) URL.revokeObjectURL(this.url);
    this.audio.pause();
    this.url = URL.createObjectURL(file);
    this.audio.src = this.url;
    this.audio.load();
  }
  setVolume(value) {
    if (!Number.isInteger(value) || value < 0 || value > 60) throw new Error("Invalid media volume.");
    this.volume = value;
    this.audio.volume = value / 100;
  }
  snapshot() {
    return {
      available: Boolean(this.url && this.audio.readyState >= 1 && !this.audio.error),
      playing: !this.audio.paused && !this.audio.ended, muted: this.audio.muted,
      position_seconds: Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0,
      duration_seconds: Number.isFinite(this.audio.duration) ? this.audio.duration : 0,
    };
  }
  async command(args) {
    if (!this.snapshot().available) throw new Error("Select a supported local audio file first.");
    if (!["play", "pause", "seek", "mute", "unmute"].includes(args.action)
      || Object.keys(args).some((key) => !["action", "position_seconds"].includes(key))
      || ("position_seconds" in args) !== (args.action === "seek")) throw new Error("Invalid media command.");
    if (args.action === "play") await this.audio.play();
    if (args.action === "pause") this.audio.pause();
    if (args.action === "mute") this.audio.muted = true;
    if (args.action === "unmute") this.audio.muted = false;
    if (args.action === "seek") {
      const value = args.position_seconds;
      if (!Number.isFinite(value) || value < 0 || value > this.audio.duration) throw new Error("Seek must be within the selected file.");
      await new Promise((resolve, reject) => {
        if (Math.abs(this.audio.currentTime - value) < .01) { resolve(); return; }
        const cleanup = () => { clearTimeout(timer); this.audio.removeEventListener("seeked", done); this.audio.removeEventListener("error", fail); };
        const done = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error("Local audio seek failed.")); };
        const timer = setTimeout(fail, 2000);
        this.audio.addEventListener("seeked", done, { once: true });
        this.audio.addEventListener("error", fail, { once: true });
        this.audio.currentTime = value;
      });
    }
    return this.snapshot();
  }
  close() {
    this.audio.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}
