#!/usr/bin/env python3
"""
Merge two YAML configuration files, excluding workflow sections.
Combines all other keys intelligently.
"""

from typing import Any

import yaml


def deep_merge_dict(base: dict[str, Any], update: dict[str, Any]) -> dict[str, Any]:
    """
    Deep merge two dictionaries, combining nested structures.
    For lists, combines unique items.
    For dicts, recursively merges.
    """
    result = base.copy()

    for key, value in update.items():
        if key in result:
            if isinstance(result[key], dict) and isinstance(value, dict):
                # Recursively merge dictionaries
                result[key] = deep_merge_dict(result[key], value)
            elif isinstance(result[key], list) and isinstance(value, list):
                # Combine lists, preserving order and removing duplicates
                combined = result[key] + value
                # Remove duplicates while preserving order
                seen = set()
                unique_list = []
                for item in combined:
                    # For hashable items, use set; for dicts/lists, compare by string
                    item_key = (
                        str(item)
                        if not isinstance(item, (str, int, float, bool, type(None)))
                        else item
                    )
                    if item_key not in seen:
                        seen.add(item_key)
                        unique_list.append(item)
                result[key] = unique_list
            else:
                # If types don't match or both are not dicts/lists, prefer update value
                result[key] = value
        else:
            # New key, just add it
            result[key] = value

    return result


def merge_yaml_configs(file1_path: str, file2_path: str, output_path: str) -> None:
    """
    Merge two YAML files, excluding workflow sections.
    """
    # Load YAML files
    with open(file1_path) as f:
        yaml1 = yaml.safe_load(f) or {}

    with open(file2_path) as f:
        yaml2 = yaml.safe_load(f) or {}

    # Remove workflow sections
    yaml1_no_workflow = {k: v for k, v in yaml1.items() if k != "workflow"}
    yaml2_no_workflow = {k: v for k, v in yaml2.items() if k != "workflow"}

    # Merge the configurations
    merged = deep_merge_dict(yaml1_no_workflow, yaml2_no_workflow)

    # Write merged result
    with open(output_path, "w") as f:
        yaml.dump(
            merged, f, default_flow_style=False, sort_keys=False, allow_unicode=True
        )

    print("✓ Merged configurations (excluding workflow sections)")
    print(f"  Input 1: {file1_path}")
    print(f"  Input 2: {file2_path}")
    print(f"  Output:  {output_path}")
    print(f"\nMerged sections: {', '.join(sorted(merged.keys()))}")


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print(
            "Usage: python3 merge_yaml_configs.py <file1.yaml> <file2.yaml> [output.yaml]"
        )
        print("\nExample:")
        print(
            "  python3 merge_yaml_configs.py backend/tool-calling-config.yaml backend/react-agent-config.yaml backend/merged-config.yaml"
        )
        sys.exit(1)

    file1 = sys.argv[1]
    file2 = sys.argv[2]
    output = sys.argv[3] if len(sys.argv) > 3 else "backend/merged-config.yaml"

    merge_yaml_configs(file1, file2, output)
