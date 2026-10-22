export class AutopilotSimulator {
  constructor(limits = { speed: [0, 120], gap: [1, 7] }) {
    this.limits = limits;
    this.visible = true;
    this.connected = false;
    this.bodyReady = true;
    this.remainder = 0;
    this.elapsed = 0;
    this.state = {
      available: true, running: false, mode: "disengaged",
      target_speed_kmh: 60, actual_speed_kmh: 0, following_gap: 3,
      lane_keeping: true, lane_visible: true, lane_offset: 0,
      lead_distance_m: 70, reason: null, rev: 0, distance_m: 0, scenario: "clear",
    };
  }
  snapshot() { return { ...this.state }; }
  setConditions({ visible = this.visible, connected = this.connected, bodyReady = this.bodyReady }) {
    this.visible = visible;
    this.connected = connected;
    this.bodyReady = bodyReady;
    if (!visible || !connected || !bodyReady) {
      this.halt(!visible ? "Page hidden" : !connected ? "Control connection lost" : "Body opening interlock");
    }
  }
  halt(reason, takeover = false) {
    const s = this.state;
    const mode = takeover || s.mode === "takeover_required" ? "takeover_required" : "disengaged";
    if (s.running || s.mode !== mode || s.reason !== reason) {
      Object.assign(s, { running: false, mode, actual_speed_kmh: 0, reason, rev: s.rev + 1 });
    }
    this.remainder = 0;
  }
  command(args, revision = this.state.rev) {
    const s = this.state;
    if (revision !== s.rev) throw new Error("Simulator state changed. Review and retry.");
    const allowed = ["action", "target_speed_kmh", "following_gap", "lane_keeping"];
    if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error("Unknown simulator field.");
    const actions = ["engage", "disengage", "update", "pause", "resume"];
    if (!actions.includes(args.action)) throw new Error("Unknown simulator action.");
    const patch = Object.keys(args).filter((key) => key !== "action");
    if (args.action === "update" && !patch.length) throw new Error("Choose a simulator setting.");
    if (["pause", "resume", "disengage"].includes(args.action) && patch.length) throw new Error("Action cannot change settings.");
    for (const [key, [min, max]] of Object.entries({
      target_speed_kmh: this.limits.speed, following_gap: this.limits.gap,
    })) {
      if (key in args && (typeof args[key] !== "number" || !Number.isFinite(args[key])
        || args[key] < min || args[key] > max || (key === "following_gap" && !Number.isInteger(args[key])))) {
        throw new Error(`${key} must be ${min} to ${max}.`);
      }
    }
    if ("lane_keeping" in args && typeof args.lane_keeping !== "boolean") throw new Error("Invalid lane keeping setting.");
    if (["engage", "resume"].includes(args.action)) {
      if (!this.visible || !this.connected || !this.bodyReady) throw new Error("Scene must be visible, connected, and closed.");
      if (["takeover_required", "fault"].includes(s.mode)) throw new Error("Clear the scenario and acknowledge takeover manually.");
    }
    if (args.action === "engage" && (!s.running || s.scenario !== "clear" && s.scenario !== "slowing_lead")) {
      throw new Error("Resume a ready scene before engagement.");
    }
    for (const key of patch) s[key] = args[key];
    if (args.action === "engage") s.mode = "active";
    if (args.action === "disengage" && s.mode !== "takeover_required" && s.mode !== "fault") s.mode = s.running ? "available" : "disengaged";
    if (args.action === "pause") this.halt("Paused manually");
    if (args.action === "resume") Object.assign(s, { running: true, mode: "disengaged", reason: null });
    s.rev++;
    return this.snapshot();
  }
  scenario(name) {
    if (!["clear", "slowing_lead", "lane_loss", "obstacle"].includes(name)) throw new Error("Unknown scenario.");
    this.state.scenario = name;
    this.state.lane_visible = name !== "lane_loss";
    this.state.lead_distance_m = name === "obstacle" ? 8 : 70;
    this.elapsed = 0;
    this.state.rev++;
  }
  acknowledge() {
    if (this.state.scenario !== "clear" || !this.visible || !this.connected || !this.bodyReady) {
      throw new Error("Select a clear scene and restore valid conditions first.");
    }
    Object.assign(this.state, { mode: "disengaged", running: false, reason: null, rev: this.state.rev + 1 });
  }
  advance(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error("Invalid simulator time step.");
    if (!this.state.running) return this.snapshot();
    this.remainder += seconds;
    while (this.remainder + 1e-9 >= .02 && this.state.running) {
      this.remainder -= .02;
      this.tick(.02);
    }
    return this.snapshot();
  }
  tick(dt) {
    const s = this.state;
    this.elapsed += dt;
    if (s.mode === "active" && (s.scenario === "obstacle" || !s.lane_visible || s.lead_distance_m < 5)) {
      this.halt(s.scenario === "obstacle" ? "Obstacle: take over" : !s.lane_visible ? "Lane markers lost: take over" : "Lead car too close: take over", true);
      return;
    }
    const leadSpeed = s.scenario === "slowing_lead" && this.elapsed > 3 ? 20 : 80;
    const desiredGap = 5 + s.following_gap * .5 * s.actual_speed_kmh / 3.6;
    let target = s.mode === "active" ? s.target_speed_kmh : 0;
    if (s.mode === "active" && s.lead_distance_m < desiredGap + 15) target = Math.min(target, leadSpeed);
    const difference = target - s.actual_speed_kmh;
    s.actual_speed_kmh += Math.sign(difference) * Math.min(Math.abs(difference), (difference > 0 ? 7.2 : 12) * dt);
    s.distance_m += s.actual_speed_kmh / 3.6 * dt;
    s.lead_distance_m = Math.min(120, s.lead_distance_m + (leadSpeed - s.actual_speed_kmh) / 3.6 * dt);
    s.lane_offset = s.lane_keeping && s.mode === "active" ? s.lane_offset * .97 : Math.sin(this.elapsed * .2) * .15;
  }
}

export const autopilot = new AutopilotSimulator();
export const motionSource = { value: "simulator" };
