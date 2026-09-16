#!/usr/bin/env python3
"""Validate the repository plugin with the same basic contracts as CI."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "plugins" / "skill-state"
MANIFEST = PLUGIN / ".codex-plugin" / "plugin.json"
SKILL = PLUGIN / "skills" / "skill-state" / "SKILL.md"
HOOKS = PLUGIN / "hooks" / "hooks.json"
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)")


def fail(errors: list[str]) -> None:
    if errors:
        print("Plugin validation failed:")
        for error in errors:
            print(f"- {error}")
        raise SystemExit(1)


def main() -> None:
    errors: list[str] = []
    if not MANIFEST.is_file():
        errors.append("missing .codex-plugin/plugin.json")
    else:
        try:
            manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"manifest is not valid JSON: {exc}")
            manifest = None
        if isinstance(manifest, dict):
            allowed = {
                "id", "name", "version", "description", "skills", "apps",
                "mcpServers", "interface", "author", "homepage", "repository",
                "license", "keywords",
            }
            unsupported = sorted(set(manifest) - allowed)
            if unsupported:
                errors.append(f"unsupported manifest fields: {', '.join(unsupported)}")
            if manifest.get("name") != "skill-state":
                errors.append("manifest name must be skill-state")
            version = manifest.get("version")
            if not isinstance(version, str) or SEMVER.fullmatch(version) is None:
                errors.append("manifest version must be strict semver")
            if not isinstance(manifest.get("description"), str) or not manifest["description"].strip():
                errors.append("manifest description must be non-empty")
            if manifest.get("skills") != "./skills/":
                errors.append("manifest skills must point to ./skills/")
            if "hooks" in manifest:
                errors.append("hooks belong in companion hooks/hooks.json, not plugin.json")

    if not SKILL.is_file():
        errors.append("missing skills/skill-state/SKILL.md")
    else:
        content = SKILL.read_text(encoding="utf-8")
        match = re.match(r"^---\n(.*?)\n---(?:\n|$)", content, re.DOTALL)
        if not match:
            errors.append("SKILL.md must start with YAML frontmatter")
        else:
            try:
                frontmatter = yaml.safe_load(match.group(1))
            except yaml.YAMLError as exc:
                errors.append(f"SKILL.md frontmatter is invalid YAML: {exc}")
                frontmatter = None
            if not isinstance(frontmatter, dict):
                errors.append("SKILL.md frontmatter must be an object")
            else:
                allowed = {"name", "description", "license", "allowed-tools", "metadata"}
                unsupported = sorted(set(frontmatter) - allowed)
                if unsupported:
                    errors.append(f"unsupported skill fields: {', '.join(unsupported)}")
                if frontmatter.get("name") != "skill-state":
                    errors.append("skill name must be skill-state")
                if not isinstance(frontmatter.get("description"), str) or not frontmatter["description"].strip():
                    errors.append("skill description must be non-empty")
        if "[TODO:" in content:
            errors.append("SKILL.md contains an unfinished TODO marker")

    if not HOOKS.is_file():
        errors.append("missing hooks/hooks.json")
    else:
        try:
            hooks = json.loads(HOOKS.read_text(encoding="utf-8"))
            if not isinstance(hooks, dict) or not isinstance(hooks.get("hooks"), dict):
                errors.append("hooks.json must contain a hooks object")
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"hooks.json is not valid JSON: {exc}")

    for path in (MANIFEST, SKILL, HOOKS):
        if path.exists():
            text = path.read_text(encoding="utf-8")
            if re.search(r"(?:/Users/|/home/|[A-Za-z]:\\Users\\)", text):
                errors.append(f"{path.relative_to(ROOT)} contains a user-specific absolute path")

    fail(errors)
    print(f"Plugin and skill validation passed: {PLUGIN}")


if __name__ == "__main__":
    main()
