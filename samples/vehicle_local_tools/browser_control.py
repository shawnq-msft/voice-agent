"""Per-browser command ownership and independently resolved execution receipts."""

from __future__ import annotations

import asyncio
import json
import math
import uuid
from typing import Any

from tool_contracts import BROWSER_TOOLS, FIELDS, LOCAL_TOOLS, validate
from vehicle import Dispatcher, ToolRejected, parse_arguments


class BrowserControl:
    def __init__(self, socket: Any) -> None:
        self.socket = socket
        self.epoch = uuid.uuid4().hex
        self.pending: dict[str, asyncio.Future] = {}
        self.expected_domains: dict[str, str] = {}
        self.states: dict[str, dict[str, Any]] = {}
        self.closed = False
        self.lock = asyncio.Lock()

    def accept_state(self, domain: str, value: Any) -> None:
        if domain not in {"media", "autopilot"} or not isinstance(value, dict):
            raise ToolRejected("INVALID_RECEIPT: Unknown browser domain.")
        allowed = set(FIELDS[domain]) | {"available"}
        required = ({"available", "playing", "muted", "position_seconds", "duration_seconds"} if domain == "media"
                    else set(FIELDS["autopilot"]) | {"available"})
        if set(value) - allowed or not required <= value.keys() or len(json.dumps(value, allow_nan=False)) > 3000:
            raise ToolRejected("INVALID_RECEIPT: Unexpected browser state.")
        boolean_fields = {"available", "running", "lane_keeping", "lane_visible", "playing", "muted"}
        numeric_fields = {"target_speed_kmh", "actual_speed_kmh", "following_gap", "lane_offset",
                          "lead_distance_m", "rev", "distance_m", "position_seconds", "duration_seconds"}
        for key, item in value.items():
            if key in boolean_fields and type(item) is not bool:
                raise ToolRejected("INVALID_RECEIPT: Invalid browser boolean.")
            if key in numeric_fields and (
                type(item) not in (int, float) or not -1e9 <= item <= 1e9 or not math.isfinite(item)
            ):
                raise ToolRejected("INVALID_RECEIPT: Invalid browser number.")
        if domain == "autopilot" and (
            value["mode"] not in {"disengaged", "available", "active", "takeover_required", "fault"}
            or value["scenario"] not in {"clear", "slowing_lead", "lane_loss", "obstacle"}
            or not 0 <= value["target_speed_kmh"] <= 120 or not 0 <= value["actual_speed_kmh"] <= 120
            or type(value["following_gap"]) is not int or not 1 <= value["following_gap"] <= 7
            or type(value["rev"]) is not int or value["rev"] < 0
            or not (value["reason"] is None or isinstance(value["reason"], str) and len(value["reason"]) <= 240)
        ):
            raise ToolRejected("INVALID_RECEIPT: Invalid simulator state.")
        if domain == "media" and (
            not 0 <= value["position_seconds"] <= value["duration_seconds"] + .5
            or value["duration_seconds"] < 0 or value["playing"] and not value["available"]
        ):
            raise ToolRejected("INVALID_RECEIPT: Invalid media state.")
        self.states[domain] = dict(value)

    def receipt(self, packet: dict[str, Any]) -> None:
        if packet.get("epoch") != self.epoch:
            raise ToolRejected("STALE_RECEIPT: Browser epoch changed.")
        future = self.pending.get(packet.get("id"))
        if future is None or future.done():
            return  # Late or duplicate receipts never complete a different command.
        if type(packet.get("ok")) is not bool:
            raise ToolRejected("INVALID_RECEIPT: Missing command outcome.")
        if packet.get("domain") != self.expected_domains[packet["id"]]:
            raise ToolRejected("INVALID_RECEIPT: Command domain does not match.")
        if packet["ok"]:
            self.accept_state(packet.get("domain"), packet.get("state"))
        elif not isinstance(packet.get("error"), str):
            raise ToolRejected("INVALID_RECEIPT: Missing failure detail.")
        future.set_result(packet)

    async def execute(self, name: str, args: dict[str, Any], *, body_ready: bool = True) -> dict[str, Any]:
        validate(name, args)
        if self.closed or self.socket.closed:
            raise ToolRejected("UNAVAILABLE: The owning browser disconnected.")
        async with self.lock:
            identity = uuid.uuid4().hex
            domain = "autopilot" if name == "control_autopilot" else "media"
            future = asyncio.get_running_loop().create_future()
            self.pending[identity] = future
            self.expected_domains[identity] = domain
            try:
                await self.socket.send_json({
                    "type": "browser_command", "id": identity, "epoch": self.epoch,
                    "name": name, "arguments": args, "body_ready": body_ready,
                    "revision": self.states.get(domain, {}).get("rev"),
                })
                async with asyncio.timeout(3):
                    packet = await future
                if not packet["ok"]:
                    raise ToolRejected(f"BROWSER_REJECTED: {packet['error'][:240]}")
                confirmed = packet["state"]
                action = args["action"]
                if domain == "autopilot":
                    mismatch = (
                        action == "engage" and (confirmed["mode"] != "active" or not confirmed["running"])
                        or action == "resume" and (not confirmed["running"] or confirmed["mode"] != "disengaged")
                        or action == "pause" and confirmed["running"]
                        or action == "disengage" and confirmed["mode"] == "active"
                        or any(confirmed[key] != value for key, value in args.items() if key != "action")
                    )
                else:
                    mismatch = (
                        action == "play" and not confirmed["playing"]
                        or action == "pause" and confirmed["playing"]
                        or action in {"mute", "unmute"} and confirmed["muted"] != (action == "mute")
                        or action == "seek" and abs(confirmed["position_seconds"] - args["position_seconds"]) > .5
                    )
                if mismatch:
                    raise ToolRejected("INVALID_RECEIPT: Browser outcome does not confirm the requested action.")
                return {"ok": True, "scope": "client_simulator" if domain == "autopilot" else "browser_media",
                        "data": packet["state"]}
            except TimeoutError as error:
                await self.socket.close(code=1011, message=b"Browser command receipt timed out")
                raise ToolRejected("TIMEOUT: Browser completion is unknown. Reconnect; verify local state.") from error
            except asyncio.CancelledError:
                if not self.socket.closed:
                    await self.socket.close(code=1011, message=b"Browser command interrupted")
                raise
            finally:
                self.pending.pop(identity, None)
                self.expected_domains.pop(identity, None)

    def close(self) -> None:
        self.closed = True
        for future in self.pending.values():
            if not future.done():
                future.set_exception(ToolRejected("DISCONNECTED: Browser completion is unknown."))
        self.states.clear()


class CockpitDispatcher(Dispatcher):
    def __init__(self, vehicle, browser: BrowserControl | None = None, grounding=None):
        super().__init__(vehicle=vehicle)
        self.browser = browser
        self.grounding = grounding
        self.async_lock = asyncio.Lock()

    def response_tools(self) -> list[dict[str, Any]]:
        names = set(LOCAL_TOOLS)
        if self.browser and not self.browser.closed:
            names.add("control_autopilot")
            if self.browser.states.get("media", {}).get("available") is True:
                names.add("control_media")
        if self.grounding and self.grounding.enabled:
            names.add("ground_public_answer")
        from tool_contracts import definitions
        return definitions(names)

    async def dispatch_async(self, call: dict[str, Any], *, cancelled=False, expected_revision=None) -> dict[str, Any]:
        async with self.async_lock:
            identity, name, raw = call.get("call_id"), call.get("name"), call.get("arguments")
            if not isinstance(identity, str) or not identity or len(identity) > 256:
                raise RuntimeError("Invalid command identity.")
            if not isinstance(name, str) or not isinstance(raw, str):
                raise RuntimeError("Invalid command envelope.")
            if identity in self.completed:
                previous_name, previous_raw, result = self.completed[identity]
                if (name, raw) != (previous_name, previous_raw):
                    raise RuntimeError("Command identity was reused with different arguments.")
                return result
            if len(self.completed) >= 1000:
                raise RuntimeError("Command limit reached. Reconnect.")
            if cancelled:
                return self.dispatch(call, cancelled=True)
            try:
                if expected_revision is not None and expected_revision != self.vehicle.revision:
                    raise ToolRejected("STALE_STATE: Settings changed. Review and retry.")
                args = parse_arguments(raw)
                if name in BROWSER_TOOLS:
                    validate(name, args)
                    if not self.browser:
                        raise ToolRejected("UNAVAILABLE: No owning browser.")
                    body_ready = not any(
                        any(parts.values()) for parts in (self.vehicle.doors, self.vehicle.windows, self.vehicle.lids)
                    )
                    if name == "control_autopilot" and args["action"] == "engage" and not body_ready:
                        raise ToolRejected("INTERLOCK: Close model doors, windows and compartments first.")
                    result = await self.browser.execute(name, args, body_ready=body_ready)
                elif name == "ground_public_answer":
                    validate(name, args)
                    if not self.grounding:
                        raise ToolRejected("UNAVAILABLE: Web grounding is not configured.")
                    result = await self.grounding.ground(args["query"])
                elif name == "read_vehicle" and self.browser:
                    validate(name, args)
                    domain = args["domain"]
                    domains = self.vehicle.domains()
                    for key, value in self.browser.states.items():
                        domains[key].update(value)
                    value = domains if domain == "all" else domains[domain]
                    if "fields" in args:
                        missing = set(args["fields"]) - value.keys()
                        if missing:
                            raise ToolRejected("UNAVAILABLE: Requested browser fields have no confirmed value.")
                        value = {k: value[k] for k in args["fields"]}
                    scope = {"autopilot": "client_simulator", "media": "browser_media"}.get(domain, "local_cockpit")
                    result = {"ok": True, "rev": self.vehicle.revision, "scope": scope, "data": value}
                    if domain == "all":
                        result["provenance"] = {"autopilot": "client_simulator", "media": "browser_media",
                                                "other": "local_preferences"}
                else:
                    result = self.execute(name, args)
            except (ToolRejected, ValueError) as error:
                text = str(error)
                code = text.split(":", 1)[0] if ":" in text else "REJECTED"
                result = {"ok": False, "error": text, "code": code}
            self.completed[identity] = (name, raw, result)
            return result
