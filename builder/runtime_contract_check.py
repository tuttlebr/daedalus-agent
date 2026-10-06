#!/usr/bin/env python3
"""Build-time verification of the NAT-free tool service and installed clients."""

import asyncio
import importlib.util
from importlib.metadata import distributions, version
from pathlib import Path
from types import SimpleNamespace

from packaging.version import Version

SECURITY_DEPENDENCY_RANGES = {
    "aiohttp": (Version("3.14.3"), Version("4")),
    "cryptography": (Version("50.0.0"), Version("51")),
    "fastfeedparser": (Version("0.5.10"), Version("0.6")),
    "pillow": (Version("12.2"), Version("13")),
    "pyjwt": (Version("2.14"), Version("3")),
    "pyopenssl": (Version("26.4"), Version("27")),
    "starlette": (Version("1.3.1"), Version("2")),
    "urllib3": (Version("2.8"), Version("3")),
}


def main():
    if importlib.util.find_spec("nat") is not None:
        raise RuntimeError("NeMo Agent Toolkit must not be installed")
    if any(
        dist.metadata["Name"].lower().startswith("nvidia-nat")
        for dist in distributions()
    ):
        raise RuntimeError("Unexpected NVIDIA NAT dependency")
    for name, (minimum, maximum) in SECURITY_DEPENDENCY_RANGES.items():
        installed = Version(version(name))
        if not minimum <= installed < maximum:
            raise RuntimeError(f"{name} is outside its security-tested range")
    from daedalus_runtime.service import create_app
    from daedalus_runtime.tools import load_tool_factories
    from tool_catalog_contract_check import check_catalog

    load_tool_factories()
    create_app()
    asyncio.run(check_catalog(skills_directory=Path("/skills")))
    # The client imports API schemas while constructing each extraction task,
    # but its wheel metadata doesn't declare the API package. Exercise the real
    # paired packages and every file-type path the application exposes. Stub
    # only the live Milvus dimension probe so this remains a build-time check.
    importlib.import_module("autonomous_agent.worker")

    import nat_nv_ingest.nat_nv_ingest as ingest_module
    from nat_nv_ingest.nat_nv_ingest import NvIngestFunctionConfig, _build_ingestor
    from nv_ingest_client.client import Ingestor

    original_dimension_check = ingest_module._validate_embedding_dimension
    ingest_module._validate_embedding_dimension = lambda *_args, **_kwargs: None
    try:
        for filename in (
            "contract.txt",
            "contract.pdf",
            "contract.docx",
            "contract.pptx",
        ):
            ingestor = _build_ingestor(
                nv_client=SimpleNamespace(),
                document_bytes=b"runtime contract",
                filename=filename,
                config=NvIngestFunctionConfig(enable_image_filter=False),
                collection_name="runtime_contract",
                chunk_size=256,
                chunk_overlap=32,
            )
            if not isinstance(ingestor, Ingestor):
                raise RuntimeError(
                    f"NV-Ingest didn't build a real chain for {filename}"
                )
    finally:
        ingest_module._validate_embedding_dimension = original_dimension_check

    print("Runtime contract passed: no NAT, typed tools, APIs, and NV-Ingest clients")


if __name__ == "__main__":
    main()
