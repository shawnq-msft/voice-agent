import assert from "node:assert/strict";
import test from "node:test";
import { AutopilotSimulator } from "./autopilot-sim.mjs";
import { LocalMediaPlayer } from "./media-player.mjs";

function active() {
  const sim = new AutopilotSimulator();
  sim.setConditions({ connected: true });
  sim.command({ action: "resume" });
  sim.command({ action: "engage" });
  return sim;
}
test("starts paused, enforces preconditions, never silently resumes assistance", () => {
  const sim = new AutopilotSimulator();
  assert.equal(sim.state.running, false);
  assert.equal(sim.state.mode, "disengaged");
  assert.throws(() => sim.command({ action: "engage" }));
  sim.setConditions({ connected: true });
  sim.command({ action: "resume" });
  assert.equal(sim.state.mode, "disengaged");
  sim.command({ action: "engage" });
  sim.advance(3);
  assert(sim.state.actual_speed_kmh > 0);
  for (const condition of [{ visible: false }, { connected: false }, { bodyReady: false }]) {
    sim.setConditions(condition);
    assert.equal(sim.state.mode, "disengaged");
    assert.equal(sim.state.running, false);
    assert.equal(sim.state.actual_speed_kmh, 0);
    sim.setConditions({ visible: true, connected: true, bodyReady: true });
    assert.equal(sim.state.running, false);
  }
});
test("fixed stepping is deterministic across render frame partitions", () => {
  const a = active(), b = active();
  for (let i = 0; i < 100; i++) a.advance(.1);
  for (let i = 0; i < 500; i++) b.advance(.02);
  assert.deepEqual(a.snapshot(), b.snapshot());
  const copy = a.snapshot(); copy.mode = "fault";
  assert.equal(a.state.mode, "active");
});
test("invalid patches do not mutate simulator state", () => {
  const sim = active(), before = sim.snapshot();
  for (const args of [
    { action: "update", target_speed_kmh: 121 }, { action: "update", following_gap: 0 },
    { action: "update", target_speed_kmh: 80, following_gap: 1.5 },
    { action: "update", lane_keeping: 1 }, { action: "resume", target_speed_kmh: 40 },
    { action: "update", target_speed_kmh: NaN }, { action: "tesla_api" }, { action: "update" },
  ]) {
    assert.throws(() => sim.command(args));
    assert.deepEqual(sim.snapshot(), before);
  }
  assert.throws(() => sim.command({ action: "pause" }, -1));
  assert.deepEqual(sim.snapshot(), before);
});
test("lane loss and obstacles require manual acknowledgement, clear scene and explicit resume", () => {
  for (const scenario of ["lane_loss", "obstacle"]) {
    const sim = active();
    sim.scenario(scenario); sim.advance(.02);
    assert.equal(sim.state.mode, "takeover_required");
    assert.equal(sim.state.running, false);
    assert.throws(() => sim.command({ action: "resume" }));
    assert.throws(() => sim.acknowledge());
    sim.command({ action: "disengage" });
    assert.equal(sim.state.mode, "takeover_required");
    sim.scenario("clear"); sim.acknowledge();
    assert.equal(sim.state.running, false);
    sim.command({ action: "resume" });
    assert.equal(sim.state.mode, "disengaged");
  }
});
test("slowing lead car changes speed without collision or external services", () => {
  const sim = active();
  sim.command({ action: "update", target_speed_kmh: 100 });
  sim.scenario("slowing_lead");
  for (let i = 0; i < 1800; i++) sim.advance(.02);
  assert(sim.state.lead_distance_m >= 5);
  assert(sim.state.actual_speed_kmh <= 25);
});
test("media requires a file and acknowledges only resolved playback", async () => {
  let resolvePlay, rejectPlay;
  const audio = {
    volume: 0, muted: false, paused: true, ended: false, readyState: 1, currentTime: 0, duration: 20,
    pause() { this.paused = true; }, load() {}, removeAttribute() {},
    play() { return new Promise((resolve, reject) => { resolvePlay = () => { this.paused = false; resolve(); }; rejectPlay = reject; }); },
  };
  const player = new LocalMediaPlayer(audio);
  await assert.rejects(player.command({ action: "play" }));
  player.url = "blob:test";
  let completed = false;
  const pending = player.command({ action: "play" }).then((value) => { completed = true; return value; });
  await Promise.resolve();
  assert.equal(completed, false);
  resolvePlay();
  assert.equal((await pending).playing, true);
  const failed = player.command({ action: "play" });
  rejectPlay(new Error("Playback blocked"));
  await assert.rejects(failed, /blocked/);
  await assert.rejects(player.command({ action: "seek", position_seconds: 21 }));
  player.setVolume(60);
  assert.equal(audio.volume, .6);
  assert.throws(() => player.setVolume(61));
  assert.equal((await player.command({ action: "mute" })).muted, true);
  assert.equal((await player.command({ action: "pause" })).playing, false);
});
