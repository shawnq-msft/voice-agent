import { autopilot, motionSource } from "./autopilot-sim.mjs";
import { LocalMediaPlayer } from "./media-player.mjs";

const $ = (id) => document.getElementById(id);
const localMedia = new LocalMediaPlayer($("local-audio"));
let channel = null;
let epoch = null;
let sharedState = null;
let contracts = [];
let lastControlContact = 0;
const pending = new Map();
const recent = new Map();
export function browserOwner() { return epoch; }
export function simulatorSnapshot() { return autopilot.snapshot(); }
export function selectedMotion() { return motionSource.value; }
function report(message) { document.dispatchEvent(new CustomEvent("cockpit-error", { detail: message })); }
function send(packet) {
  if (!channel || channel.readyState !== WebSocket.OPEN) throw new Error("Control channel is not ready. Reconnect cockpit controls.");
  channel.send(JSON.stringify(packet));
}
function publish(domain) {
  if (!epoch || channel?.readyState !== WebSocket.OPEN) return;
  send({ type: "browser_state", epoch, domain, state: domain === "autopilot" ? autopilot.snapshot() : localMedia.snapshot() });
}
export function command(name, args) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pending.delete(id); reject(new Error("Command timed out. Completion is unknown; check local state."));
    }, 5000);
    pending.set(id, { resolve, reject, timeout });
    try { send({ type: "command", id, name, arguments: args, revision: sharedState?.rev }); }
    catch (e) { clearTimeout(timeout); pending.delete(id); reject(e); }
  });
}
export function applySnapshot(state) {
  sharedState = state;
  const d = state.domains;
  if (!d) return;
  localMedia.setVolume(state.volume_percent);
  autopilot.setConditions({ bodyReady: ![state.doors, state.windows, state.lids].some((parts) => Object.values(parts).some(Boolean)) });
  document.documentElement.dataset.cockpitTheme = d.cluster.theme;
  document.documentElement.dataset.clusterLayout = d.cluster.layout;
  $("cluster-readout").style.opacity = d.cluster.brightness / 100;
  $("cluster-units").value = d.cluster.units;
  $("cluster-theme").value = d.cluster.theme;
  $("cluster-layout").value = d.cluster.layout;
  $("cluster-brightness").value = d.cluster.brightness;
  $("climate-fan").value = d.climate.fan;
  for (const key of ["power", "ac", "auto", "recirculation", "defrost"]) $(`climate-${key}`).checked = d.climate[key];
  for (const key of ["avoid_tolls", "avoid_highways"]) $(`nav-${key}`).checked = d.navigation[key];
  $("assist-detail").value = d.assist.detail;
  $("assist-tips").checked = d.assist.tips;
  $("assist-help").hidden = !d.assist.tips;
  $("assist-explanation").hidden = d.assist.detail !== "detailed";
  $("phone-notifications").checked = d.phone.notifications;
  $("phone-detail").value = d.phone.detail;
  $("phone-preference-status").textContent = `Panel notifications ${d.phone.notifications ? "enabled" : "disabled"}${d.phone.detail === "detailed" ? " / HFP calling and PBAP contacts need a native provider." : ""}`;
  publish("autopilot");
}
export function showSources(result) {
  if (result.scope !== "public_web" || !result.ok) return;
  $("sources").replaceChildren();
  $("source-status").textContent = `${result.cached ? "Cached evidence" : "Retrieved evidence"} / ${result.retrieved_at}`;
  for (const source of result.sources) {
    const url = new URL(source.url);
    if (url.protocol !== "https:" || url.username || url.password) continue;
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.textContent = `${source.id}: ${source.title}`;
    const text = document.createElement("p");
    text.textContent = source.excerpt;
    li.append(link, text); $("sources").append(li);
  }
}
export function connectControls(info) {
  contracts = info.contracts;
  const simSpec = contracts.find((tool) => tool.name === "control_autopilot").parameters.properties;
  autopilot.limits = {
    speed: [simSpec.target_speed_kmh.minimum, simSpec.target_speed_kmh.maximum],
    gap: [simSpec.following_gap.minimum, simSpec.following_gap.maximum],
  };
  for (const [id, spec] of [
    ["sim-speed", simSpec.target_speed_kmh], ["sim-gap", simSpec.following_gap],
    ["climate-fan", contracts.find((t) => t.name === "set_climate").parameters.properties.fan],
    ["cluster-brightness", contracts.find((t) => t.name === "set_cluster_preferences").parameters.properties.brightness],
  ]) { $(id).min = spec.minimum; $(id).max = spec.maximum; }
  if (channel && channel.readyState < WebSocket.CLOSING) return;
  $("control-status").textContent = "Connecting controls";
  channel = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/control`);
  channel.onmessage = async (event) => {
    try {
      lastControlContact = performance.now();
      const packet = JSON.parse(event.data);
      if (packet.type === "control_ready") {
        epoch = packet.epoch;
        autopilot.setConditions({ connected: true });
        $("control-status").textContent = "Controls connected";
        applySnapshot(info.state); publish("media"); publish("autopilot");
      } else if (packet.type === "browser_command") {
        if (packet.epoch !== epoch) throw new Error("Stale browser owner.");
        if (recent.has(packet.id)) { send(recent.get(packet.id)); return; }
        const domain = packet.name === "control_autopilot" ? "autopilot" : "media";
        let receipt;
        try {
          if (!["control_autopilot", "control_media"].includes(packet.name)) throw new Error("Unsupported browser command.");
          if (domain === "autopilot") {
            if (motionSource.value !== "simulator") throw new Error("Select the Autopilot scene instead of the reference trace.");
            autopilot.setConditions({ bodyReady: packet.body_ready, visible: !document.hidden });
          }
          const state = domain === "autopilot"
            ? autopilot.command(packet.arguments, packet.revision ?? autopilot.state.rev)
            : await localMedia.command(packet.arguments);
          receipt = { type: "browser_receipt", epoch, id: packet.id, domain, ok: true, state };
        } catch (e) {
          receipt = { type: "browser_receipt", epoch, id: packet.id, domain, ok: false, error: e.message };
        }
        if (recent.size >= 1000) recent.delete(recent.keys().next().value);
        recent.set(packet.id, receipt); send(receipt);
      } else if (packet.type === "command_result") {
        const request = pending.get(packet.id);
        if (request) {
          clearTimeout(request.timeout); pending.delete(packet.id);
          request.resolve(packet);
        }
      } else if (packet.type === "snapshot") {
        document.dispatchEvent(new CustomEvent("cockpit-snapshot", { detail: packet.state }));
      } else if (packet.type === "control_error") {
        throw new Error(packet.message);
      }
    } catch (e) { report(e.message); channel?.close(); }
  };
  channel.onclose = () => {
    epoch = null; recent.clear();
    autopilot.setConditions({ connected: false });
    localMedia.audio.pause();
    for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error("Controls disconnected; completion is unknown.")); }
    pending.clear();
    $("control-status").textContent = "Controls disconnected / simulator paused";
  };
  channel.onerror = () => report("Cockpit control connection failed.");
  $("reconnect-controls").onclick = () => connectControls({ ...info, state: sharedState || info.state });
}

async function invoke(button, name, args) {
  button.disabled = true;
  try {
    const packet = await command(name, args);
    document.dispatchEvent(new CustomEvent("cockpit-snapshot", { detail: packet.state }));
    document.dispatchEvent(new CustomEvent("cockpit-result", { detail: { name, result: packet.result } }));
    if (!packet.result.ok) throw new Error(packet.result.error);
  } catch (e) { report(e.message); }
  finally { button.disabled = false; }
}
for (const action of ["resume", "engage", "disengage", "pause"]) {
  $(`sim-${action}`).onclick = (event) => invoke(event.currentTarget, "control_autopilot", { action });
}
$("sim-update").onclick = (event) => invoke(event.currentTarget, "control_autopilot", {
  action: "update", target_speed_kmh: Number($("sim-speed").value),
  following_gap: Number($("sim-gap").value), lane_keeping: $("sim-lane").checked,
});
$("sim-scenario").onchange = () => {
  try { autopilot.scenario($("sim-scenario").value); publish("autopilot"); } catch (e) { report(e.message); }
};
$("sim-acknowledge").onclick = () => {
  try { autopilot.acknowledge(); publish("autopilot"); } catch (e) { report(e.message); }
};
$("motion-source").onchange = () => {
  autopilot.halt("Motion source changed");
  motionSource.value = $("motion-source").value;
  publish("autopilot");
};
$("media-file").onchange = () => {
  try { localMedia.select($("media-file").files[0]); $("media-source").textContent = "Local audio selected / not uploaded"; }
  catch (e) { report(e.message); }
};
for (const event of ["loadedmetadata", "play", "pause", "ended", "seeked", "error"]) {
  localMedia.audio.addEventListener(event, () => {
    $("media-availability").textContent = localMedia.snapshot().available ? "LOCAL AUDIO READY" : "NO AUDIO SOURCE";
    publish("media");
    if (event === "error") report("Selected audio cannot be decoded. Choose another supported file.");
  });
}
for (const action of ["play", "pause", "mute", "unmute"]) {
  $(`media-${action}`).onclick = (event) => invoke(event.currentTarget, "control_media", { action });
}
$("media-seek").onclick = (event) => invoke(event.currentTarget, "control_media", {
  action: "seek", position_seconds: Number($("media-position").value),
});
function bind(id, name, makeArgs) { $(id).onchange = (event) => invoke(event.currentTarget, name, makeArgs()); }
bind("climate-fan", "set_climate", () => ({ fan: Number($("climate-fan").value) }));
for (const key of ["power", "ac", "auto", "recirculation", "defrost"]) {
  bind(`climate-${key}`, "set_climate", () => ({ [key]: $(`climate-${key}`).checked }));
}
for (const key of ["avoid_tolls", "avoid_highways"]) bind(`nav-${key}`, "set_navigation_preferences", () => ({ [key]: $(`nav-${key}`).checked }));
$("nav-clear").onclick = (event) => invoke(event.currentTarget, "clear_destination", {});
for (const key of ["units", "theme", "layout", "brightness"]) bind(`cluster-${key}`, "set_cluster_preferences",
  () => ({ [key]: key === "brightness" ? Number($(`cluster-${key}`).value) : $(`cluster-${key}`).value }));
bind("assist-detail", "set_assist_preferences", () => ({ detail: $("assist-detail").value }));
bind("assist-tips", "set_assist_preferences", () => ({ tips: $("assist-tips").checked }));
bind("phone-notifications", "set_phone_preferences", () => ({ notifications: $("phone-notifications").checked }));
bind("phone-detail", "set_phone_preferences", () => ({ detail: $("phone-detail").value }));
document.addEventListener("visibilitychange", () => {
  autopilot.setConditions({ visible: !document.hidden });
  publish("autopilot");
});
window.addEventListener("pagehide", () => { autopilot.halt("Page closed"); localMedia.close(); channel?.close(); });
setInterval(() => {
  if (!epoch) return;
  if (performance.now() - lastControlContact > 5000) {
    autopilot.setConditions({ connected: false });
    report("Cockpit heartbeat lost. Simulator paused; reconnect controls explicitly.");
    channel?.close();
    return;
  }
  send({ type: "ping" }); publish("autopilot"); publish("media");
}, 1000);

let previous = performance.now(), lastRevision = -1;
const canvas = $("sim-scene"), ctx = canvas.getContext("2d");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
function frame(time) {
  autopilot.advance(Math.min(.1, Math.max(0, (time - previous) / 1000)));
  previous = time;
  const s = autopilot.snapshot();
  $("sim-state").textContent = `${s.mode.replaceAll("_", " ")} / ${s.running ? "scene running" : "paused"}`;
  $("sim-warning").textContent = s.reason || "Browser-only scene. No real driving or Tesla connection.";
  $("sim-speed-readout").textContent = `${s.actual_speed_kmh.toFixed(1)} km/h / target ${s.target_speed_kmh}`;
  $("sim-gap-readout").textContent = `Gap ${s.following_gap} / lead ${s.lead_distance_m.toFixed(1)} m`;
  $("sim-acknowledge").disabled = !["takeover_required", "fault"].includes(s.mode);
  $("sim-panel").dataset.mode = s.mode;
  if (s.rev !== lastRevision) {
    lastRevision = s.rev;
    for (const [id, value] of [["sim-speed", s.target_speed_kmh], ["sim-gap", s.following_gap]]) {
      if (document.activeElement !== $(id)) $(id).value = value;
    }
    if (document.activeElement !== $("sim-lane")) $("sim-lane").checked = s.lane_keeping;
    publish("autopilot");
  }
  if (ctx) {
    ctx.fillStyle = "#0b1624"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = s.lane_visible ? "#76d9cb" : "#bd6f52"; ctx.lineWidth = 3;
    ctx.setLineDash(s.lane_visible ? [18, 16] : [4, 25]);
    ctx.lineDashOffset = reduced.matches ? 0 : -s.distance_m * 4 % 34;
    for (const x of [95, 265]) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 220); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.fillStyle = s.mode === "active" ? "#73e8cf" : "#9baac0";
    ctx.fillRect(165 + s.lane_offset * 50, 160, 30, 45);
    ctx.fillStyle = s.scenario === "obstacle" ? "#f48576" : "#e5bf76";
    ctx.fillRect(165, Math.max(10, 145 - s.lead_distance_m), 30, 40);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
