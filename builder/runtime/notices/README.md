# Runtime source notices

The document decoder and detector ports use CPython 3.12.3 and
charset-normalizer 3.4.9 as compatibility references.

- [CPython](https://github.com/python/cpython/tree/v3.12.3): ISO-2022 and UTF-7
  decoding, the reranker's NaN-compatible list ordering, and public-address
  classification; see [cpython.txt](cpython.txt).
- [charset-normalizer](https://github.com/jawah/charset_normalizer): text chaos
  and coherence algorithms; see [charset-normalizer.txt](charset-normalizer.txt).

Unicode/codec mappings and regression fixtures are generated from the retained
image by the document exporters in `builder/migration/`. Both image profiles
package these notices under `/workspace/runtime-notices`.

Embedding response decompression uses `zstd` 0.13.3 with the lockfile's
`zstd-safe` 7.3.0, `zstd-sys` 2.1.1 and vendored Zstandard 1.5.7. This preserves
the provider's `gzip, deflate, zstd` HTTP contract; gzip and deflate use `flate2`.

- [zstd-rs](https://github.com/gyscos/zstd-rs):
  [zstd license](zstd-0.13.3-LICENSE.txt),
  [safe wrapper license](zstd-safe-7.3.0-LICENSE.txt), and
  [sys wrapper license](zstd-sys-2.1.1-LICENSE.txt).
- [Zstandard](https://github.com/facebook/zstd/tree/v1.5.7):
  [BSD license](zstd-1.5.7-BSD-LICENSE.txt).

Public HTTP uses the retained certifi 2026.6.17 CA bundle under the
[Mozilla Public License 2.0](certifi.txt). `export_public_http.py` exports the
bundle and its hash. Both images package it as `/workspace/runtime-public-ca.pem`;
standalone binaries embed the same fallback. Update this resource alongside the
Python dependency when rotating public trust roots. Public fetching ignores
proxy and CA environment overrides, preserving `trust_env=False`.
