"""Read / validate / apply the engine's configuration singleton.

The engine owns `config.config.SETTINGS`; this module is the only place the
API mutates it. Mutations happen *in place* so every already-imported module
(`load_config()` returns the same object) sees the new values immediately -
exactly as the Streamlit Settings page does today.

Guarantees
----------
* A rejected patch leaves the singleton untouched (validate-then-write).
* ``paths`` are read-only: they are reported by GET /config but never accepted.
* Changes are reported as dotted leaf paths, so the UI can show what applied.
"""
from __future__ import annotations

import copy
import dataclasses
from dataclasses import fields
from typing import Any

from pydantic import ValidationError

from config.config import SETTINGS, Settings, load_config
from src.api.schemas import SettingsModel

# Sections that live on the Settings singleton and are patchable.
_SECTIONS = ("video", "preprocess", "color", "shape", "tracking", "features",
             "calibration", "anomaly", "zone", "dashboard")


class ConfigValidationError(Exception):
    """Raised when a merged configuration document fails validation."""

    def __init__(self, errors: list[dict]):
        super().__init__("configuration rejected")
        self.errors = _clean_errors(errors)


def _clean_errors(errors: list[dict]) -> list[dict]:
    """Keep only JSON-safe fields (pydantic's ``ctx`` may hold exceptions)."""
    cleaned: list[dict] = []
    for err in errors:
        cleaned.append({
            "loc": [str(part) for part in err.get("loc", ())],
            "msg": str(err.get("msg", "invalid value")),
            "type": str(err.get("type", "value_error")),
        })
    return cleaned


# --------------------------------------------------------------- serialisation
def _paths_payload() -> dict:
    cfg = load_config()
    return {"samples": str(cfg.paths.samples), "output": str(cfg.paths.output),
            "db": str(cfg.paths.db), "read_only": True}


def serialize_config() -> dict:
    """The public JSON document for the current configuration."""
    cfg = load_config()
    out: dict[str, Any] = {}
    for section in _SECTIONS:
        out[section] = dataclasses.asdict(getattr(cfg, section))
    out["paths"] = _paths_payload()
    return out


# ------------------------------------------------------------------- patching
def _deep_merge(base: dict, patch: dict) -> dict:
    merged = dict(base)
    for key, value in patch.items():
        current = merged.get(key)
        if isinstance(value, dict) and isinstance(current, dict):
            merged[key] = _deep_merge(current, value)
        else:
            merged[key] = value
    return merged


def _coerce(section: str, value: Any) -> Any:
    """Normalise JSON arrays back into the tuples the engine expects."""
    if section == "color" and isinstance(value, dict) and "ranges" in value:
        value = dict(value)
        value["ranges"] = {name: tuple(rng)
                           for name, rng in value["ranges"].items()}
    return value


def _write_anomaly(target, data: dict) -> None:
    for name, value in data.items():
        if name == "rule" and isinstance(value, dict):
            for r_name, r_value in value.items():
                setattr(target.rule, r_name, r_value)
        elif name == "weights" and isinstance(value, dict):
            target.weights = {k: float(v) for k, v in value.items()}
        else:
            setattr(target, name, value)


def _write_config(validated: dict) -> None:
    cfg = load_config()
    for section in _SECTIONS:
        if section not in validated:
            continue
        data = _coerce(section, validated[section])
        if section == "anomaly":
            _write_anomaly(cfg.anomaly, data)
        elif dataclasses.is_dataclass(getattr(cfg, section)):
            target = getattr(cfg, section)
            for name, value in data.items():
                setattr(target, name, value)
        else:                                   # pragma: no cover - defensive
            setattr(cfg, section, data)


def _diff(before: Any, after: Any, prefix: str = "") -> list[str]:
    """Dotted leaf paths whose values differ between two documents."""
    if isinstance(before, dict) and isinstance(after, dict):
        keys = set(before) | set(after)
        changed: list[str] = []
        for key in sorted(keys):
            path = f"{prefix}.{key}" if prefix else str(key)
            changed += _diff(before.get(key), after.get(key), path)
        return changed
    if isinstance(before, (list, tuple)) and isinstance(after, (list, tuple)):
        if list(before) != list(after):
            return [prefix]
        return []
    return [] if before == after else [prefix]


def apply_patch(patch: dict) -> tuple[dict, list[str]]:
    """Validate a deep-partial patch, apply it, return (full config, changes).

    Raises `ConfigValidationError` with pydantic's error list when the merged
    document is invalid; the singleton is never partially written.
    """
    if not isinstance(patch, dict):
        raise ConfigValidationError([
            {"loc": [], "msg": "request body must be a JSON object",
             "type": "type_error.dict"}])
    before = serialize_config()
    base = {k: v for k, v in copy.deepcopy(before).items() if k != "paths"}
    merged = _deep_merge(base, patch)
    try:
        validated = SettingsModel.model_validate(merged).model_dump()
    except ValidationError as exc:
        raise ConfigValidationError(exc.errors(include_url=False)) from exc
    _write_config(validated)
    after = serialize_config()
    return after, _diff(before, after)


# --------------------------------------------------------------------- resets
def reset_config() -> tuple[dict, list[str]]:
    """Restore every engine setting to its dataclass default (in place)."""
    before = serialize_config()
    defaults = Settings()
    cfg = load_config()
    for field in fields(cfg):
        setattr(cfg, field.name, getattr(defaults, field.name))
    after = serialize_config()
    return after, _diff(before, after)


# Kept for callers that only need the pristine baseline document.
def default_config() -> dict:
    return serialize_config()
