"""Shared, bounded contracts for cockpit commands and their UI metadata."""

from __future__ import annotations

import math
from typing import Any


def choice(*values: str) -> dict[str, Any]:
    return {"type": "string", "enum": list(values)}


def number(low: float, high: float, *, integer: bool = False) -> dict[str, Any]:
    return {"type": "integer" if integer else "number", "minimum": low, "maximum": high}


BOOL = {"type": "boolean"}
TEXT = {"type": "string", "minLength": 1, "maxLength": 200}
PARTS = ("front_left", "front_right", "rear_left", "rear_right")
DOMAINS = ("climate", "media", "navigation", "cluster", "assist", "phone", "body", "autopilot")
FIELDS = {
    "climate": ("temperature_c", "fan", "power", "ac", "auto", "recirculation", "defrost"),
    "media": ("volume_percent", "available", "playing", "muted", "position_seconds", "duration_seconds"),
    "navigation": ("destination", "avoid_tolls", "avoid_highways"),
    "cluster": ("units", "theme", "layout", "brightness"),
    "assist": ("detail", "tips", "hardware_available"),
    "phone": ("notifications", "detail", "connected", "calling_available"),
    "body": ("doors", "windows", "lids"),
    "autopilot": ("running", "mode", "target_speed_kmh", "actual_speed_kmh", "following_gap",
                  "lane_keeping", "lane_visible", "lane_offset", "lead_distance_m",
                  "reason", "rev", "distance_m", "scenario"),
}

# name: (description, properties, required); this registry also supplies browser limits.
COMMANDS: dict[str, tuple[str, dict[str, Any], tuple[str, ...]]] = {
    "read_vehicle": ("Read one local domain, or a bounded all-domain summary.", {
        "domain": choice(*DOMAINS, "all"),
        "fields": {"type": "array", "items": choice(*sorted({f for fields in FIELDS.values() for f in fields})),
                   "maxItems": 8, "uniqueItems": True},
    }, ("domain",)),
    "set_climate": ("Change local cabin settings. At least one field is required.", {
        "temperature_c": number(16, 30), "fan": number(0, 7, integer=True),
        "power": BOOL, "ac": BOOL, "auto": BOOL, "recirculation": BOOL, "defrost": BOOL,
    }, ()),
    "set_media_volume": ("Set media volume, not assistant speech volume.", {
        "volume_percent": number(0, 60, integer=True),
    }, ("volume_percent",)),
    "control_media": ("Control the owning browser's selected audio file.", {
        "action": choice("play", "pause", "seek", "mute", "unmute"),
        "position_seconds": number(0, 86400),
    }, ("action",)),
    "set_destination": ("Save destination text. No route or arrival time is available.", {
        "destination": TEXT,
    }, ("destination",)),
    "clear_destination": ("Clear the saved destination.", {}, ()),
    "set_navigation_preferences": ("Store local route preferences, without calculating a route.", {
        "avoid_tolls": BOOL, "avoid_highways": BOOL,
    }, ()),
    "set_cluster_preferences": ("Change instrument presentation, not telemetry or mandatory warnings.", {
        "units": choice("metric", "imperial"), "theme": choice("dark", "light"),
        "layout": choice("standard", "compact"), "brightness": number(20, 100, integer=True),
    }, ()),
    "set_assist_preferences": ("Change assistance-panel presentation only.", {
        "detail": choice("brief", "detailed"), "tips": BOOL,
    }, ()),
    "control_autopilot": ("Control only the browser Autopilot simulator. Never controls vehicle hardware.", {
        "action": choice("engage", "disengage", "update", "pause", "resume"),
        "target_speed_kmh": number(0, 120), "following_gap": number(1, 7, integer=True),
        "lane_keeping": BOOL,
    }, ("action",)),
    "ground_public_answer": ("Ground current or uncertain public facts with cited WebIQ sources. Never send private data.", {
        "query": {"type": "string", "minLength": 3, "maxLength": 240},
    }, ("query",)),
    "set_phone_preferences": ("Change local phone-panel preferences. No phone connection or calling.", {
        "notifications": BOOL, "detail": choice("brief", "detailed"),
    }, ()),
    "set_vehicle_doors": ("Open or close 3D model doors. Does not unlock doors.", {
        "door": choice("all", *PARTS), "is_open": BOOL,
    }, ("door", "is_open")),
    "set_vehicle_windows": ("Lower model glass with is_open=true; raise it with false.", {
        "window": choice("all", *PARTS), "is_open": BOOL,
    }, ("window", "is_open")),
    "set_vehicle_lid": ("Open or close the model hood or trunk.", {
        "lid": choice("hood", "trunk"), "is_open": BOOL,
    }, ("lid", "is_open")),
}
BROWSER_TOOLS = frozenset({"control_media", "control_autopilot"})
LOCAL_TOOLS = frozenset(COMMANDS) - BROWSER_TOOLS - {"ground_public_answer"}


def definitions(names=None) -> list[dict[str, Any]]:
    return [{
        "type": "function", "name": name, "description": description,
        "parameters": {"type": "object", "properties": properties,
                       "required": list(required), "additionalProperties": False},
    } for name, (description, properties, required) in COMMANDS.items()
        if names is None or name in names]


def validate(name: str, args: dict[str, Any]) -> None:
    """Validate the complete patch before any handler changes state."""
    if name not in COMMANDS:
        raise ValueError("UNAVAILABLE: Unknown command.")
    _, properties, required = COMMANDS[name]
    if not isinstance(args, dict) or set(args) - properties.keys() or not set(required) <= args.keys():
        raise ValueError("INVALID_ARGUMENT: Fields do not match the command contract.")
    if name.startswith("set_") and not required and not args:
        raise ValueError("INVALID_ARGUMENT: Supply at least one setting.")
    for key, value in args.items():
        spec = properties[key]
        kind = spec["type"]
        valid = (
            type(value) is bool if kind == "boolean" else
            type(value) is int if kind == "integer" else
            type(value) in (int, float) if kind == "number" else
            isinstance(value, str) if kind == "string" else
            isinstance(value, list)
        )
        if not valid:
            raise ValueError(f"INVALID_ARGUMENT: Invalid type for {key}.")
        if kind in {"integer", "number"} and (
            not spec["minimum"] <= value <= spec["maximum"] or not math.isfinite(value)
        ):
            raise ValueError(f"OUT_OF_RANGE: {key} must be {spec['minimum']} to {spec['maximum']}.")
        if kind == "string" and (
            ("enum" in spec and value not in spec["enum"])
            or not spec.get("minLength", 0) <= len(value.strip()) <= spec.get("maxLength", 1000)
            or any(ord(c) < 32 or ord(c) == 127 for c in value)
        ):
            raise ValueError(f"INVALID_ARGUMENT: Invalid value for {key}.")
        if kind == "array" and (
            len(value) > spec["maxItems"] or any(not isinstance(v, str) for v in value)
            or len(value) != len(set(value)) or any(v not in spec["items"]["enum"] for v in value)
        ):
            raise ValueError("INVALID_ARGUMENT: Invalid read projection.")
    if name == "read_vehicle" and "fields" in args:
        if args["domain"] == "all" or not args["fields"] or set(args["fields"]) - set(FIELDS[args["domain"]]):
            raise ValueError("INVALID_ARGUMENT: Select fields from one domain.")
    if name == "control_media" and (("position_seconds" in args) != (args["action"] == "seek")):
        raise ValueError("INVALID_ARGUMENT: Only seek requires position_seconds.")
    if name == "control_autopilot":
        patch = set(args) - {"action"}
        if args["action"] == "update" and not patch:
            raise ValueError("INVALID_ARGUMENT: Supply an assistance setting.")
        if args["action"] in {"pause", "resume", "disengage"} and patch:
            raise ValueError("INVALID_ARGUMENT: This action does not accept settings.")
