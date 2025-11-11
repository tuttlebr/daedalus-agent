#!/usr/bin/env python3
"""
Compare two YAML files by their keys to identify structural differences.
"""

from pathlib import Path
from typing import Any

import yaml


def get_all_keys(data: Any, prefix: str = "") -> set[str]:
    """
    Recursively extract all keys from a nested dictionary structure.
    Returns a set of dot-notation keys (e.g., 'functions.code_generation._type').
    """
    keys = set()

    if isinstance(data, dict):
        for key, value in data.items():
            current_key = f"{prefix}.{key}" if prefix else key
            keys.add(current_key)

            # Recursively get keys from nested structures
            if isinstance(value, (dict, list)):
                keys.update(get_all_keys(value, current_key))
    elif isinstance(data, list):
        # For lists, check if items are dicts and extract their keys
        for idx, item in enumerate(data):
            if isinstance(item, dict):
                keys.update(get_all_keys(item, f"{prefix}[{idx}]"))

    return keys


def get_nested_value(data: Any, key_path: str) -> Any:
    """
    Get a value from a nested structure using dot notation.
    """
    keys = key_path.split(".")
    current = data

    for key in keys:
        if "[" in key and "]" in key:
            # Handle list indices like 'functions[0]'
            base_key, index = key.split("[")
            index = int(index.rstrip("]"))
            if isinstance(current, dict) and base_key in current:
                current = current[base_key]
                if isinstance(current, list) and index < len(current):
                    current = current[index]
                else:
                    return None
            else:
                return None
        else:
            if isinstance(current, dict) and key in current:
                current = current[key]
            else:
                return None

    return current


def compare_yaml_keys(file1_path: str, file2_path: str) -> None:
    """
    Compare two YAML files and print differences in their key structures.
    """
    # Load YAML files
    with open(file1_path) as f:
        yaml1 = yaml.safe_load(f)

    with open(file2_path) as f:
        yaml2 = yaml.safe_load(f)

    # Get all keys from both files
    keys1 = get_all_keys(yaml1)
    keys2 = get_all_keys(yaml2)

    # Find differences
    only_in_file1 = keys1 - keys2
    only_in_file2 = keys2 - keys1
    common_keys = keys1 & keys2

    # Print results
    print(f"\n{'='*80}")
    print(f"Comparing: {Path(file1_path).name} vs {Path(file2_path).name}")
    print(f"{'='*80}\n")

    print(f"Total keys in file 1: {len(keys1)}")
    print(f"Total keys in file 2: {len(keys2)}")
    print(f"Common keys: {len(common_keys)}")
    print(f"Keys only in file 1: {len(only_in_file1)}")
    print(f"Keys only in file 2: {len(only_in_file2)}\n")

    if only_in_file1:
        print(f"{'─'*80}")
        print(f"Keys ONLY in {Path(file1_path).name}:")
        print(f"{'─'*80}")
        for key in sorted(only_in_file1):
            value = get_nested_value(yaml1, key)
            value_preview = (
                str(value)[:60] + "..."
                if isinstance(value, str) and len(str(value)) > 60
                else value
            )
            print(f"  • {key}: {value_preview}")
        print()

    if only_in_file2:
        print(f"{'─'*80}")
        print(f"Keys ONLY in {Path(file2_path).name}:")
        print(f"{'─'*80}")
        for key in sorted(only_in_file2):
            value = get_nested_value(yaml2, key)
            value_preview = (
                str(value)[:60] + "..."
                if isinstance(value, str) and len(str(value)) > 60
                else value
            )
            print(f"  • {key}: {value_preview}")
        print()

    # Compare values for common keys
    different_values = []
    for key in sorted(common_keys):
        val1 = get_nested_value(yaml1, key)
        val2 = get_nested_value(yaml2, key)

        if val1 != val2:
            different_values.append((key, val1, val2))

    if different_values:
        print(f"{'─'*80}")
        print("Common keys with DIFFERENT values:")
        print(f"{'─'*80}")
        for key, val1, val2 in different_values[:20]:  # Limit to first 20
            print(f"  • {key}:")
            print(f"    File 1: {val1}")
            print(f"    File 2: {val2}")
        if len(different_values) > 20:
            print(f"\n  ... and {len(different_values) - 20} more differences")
        print()


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 3:
        print("Usage: python3 compare_yaml_keys.py <file1.yaml> <file2.yaml>")
        print("\nExample:")
        print(
            "  python3 compare_yaml_keys.py backend/tool-calling-config.yaml backend/react-agent-config.yaml"
        )
        sys.exit(1)

    compare_yaml_keys(sys.argv[1], sys.argv[2])
