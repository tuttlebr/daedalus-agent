"""Run the retained skill registry against real files and child processes."""

import argparse
import asyncio
import json
import os
from pathlib import Path
from unittest.mock import patch


async def processes_gone(path):
    if not path.exists():
        return None
    record = json.loads(path.read_text())
    # real process isolation assertion
    assert record["parent"] == record["group"] == record["session"]
    for _ in range(500):
        live = []
        for pid in [record["parent"], *record.get("children", [])]:
            try:
                state = (
                    Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
                )
                if state != "Z":
                    live.append(pid)
            except FileNotFoundError:
                pass
        if not live:
            return True
        await asyncio.sleep(0.01)
    raise AssertionError("A skill process survived completion or cancellation")


async def main(args):
    from agent_skills import register  # noqa: F401 - retained factory registration
    from agent_skills.load_events import skill_load_scope
    from daedalus_runtime.tools import ToolRegistry

    document = json.loads(args.input.read_text())
    output = []
    for case in document["cases"]:
        registry = ToolRegistry(
            {"functions": {"skills": {"_type": "agent_skills", **case["config"]}}}
        )
        loaded = []
        with patch.dict(
            os.environ, {**document["environment"], **case.get("env", {})}, clear=True
        ), skill_load_scope(lambda event: loaded.append(event.skill_name)):
            try:
                tool = await registry.get_function("skills")
                if case.get("cancel"):
                    task = asyncio.create_task(tool.ainvoke(case["input"]))
                    try:
                        for _ in range(500):
                            if Path(case["ready"]).exists():
                                break
                            # process barrier
                            assert not task.done(), task.result()
                            await asyncio.sleep(0.01)
                        else:
                            raise AssertionError(
                                "Skill did not reach cancellation barrier"
                            )
                    finally:
                        task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        result = {"cancelled": True}
                    else:
                        raise AssertionError("Skill ignored cancellation")
                    result["recovery"] = await tool.ainvoke(
                        {"operation": "list_skills"}
                    )
                else:
                    try:
                        result = {"ok": await tool.ainvoke(case["input"])}
                    except Exception as exc:
                        result = {"error": type(exc).__name__}
                result["loaded"] = loaded
                result["processes_gone"] = await processes_gone(Path(case["processes"]))
                output.append({"name": case["name"], "result": result})
            finally:
                await registry.close()
        print("Retained skill process:", case["name"], flush=True)
    args.output.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
