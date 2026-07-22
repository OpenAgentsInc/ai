# AI SDK graph-memory release receipt

Date: 2026-07-22. Train: `0.2.1-rc.2`. Dist-tag: `rc`.

## Source and gates

The release source commit is
`92e212f296209bde75b9599b0bcc5f44e2368891`. The full repository check passed
at that commit. It ran 76 test files and skipped 6 test files. It passed 727
tests and skipped 13 tests. Type checks passed for all 11 packages. Format,
lint, export-map, and public API-surface checks passed.

The API-surface extractor uses
`openagents.ai.public_export_surface.v2`. It isolates each entry point and
normalizes checkout paths and generated TypeScript symbol identifiers. Two
additional surface checks passed after the full check.

An independent review found no release-blocking defect. Pack inspection found
no test file in any published package. The package manifests use exact
`0.2.1-rc.2` versions for internal dependencies. The conformance package has
the peer range `vite-plus >=0.2.4 <1`.

## Published artifacts

The registry integrity value for each package equals the inspected local
tarball integrity value.

| Package                                    |   Bytes | SHA-256                                                            | Registry integrity                                                                                |
| ------------------------------------------ | ------: | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `@openagentsinc/agent-runtime-schema`      |  51,454 | `02aa4131226281a3d1dbd360f74357c268a19adc55fdcb91351f781663dd2e52` | `sha512-xSC/laUZcFaF8AUOEshQy01Q1QuOdrYAEx48PPUjRjPO/dP4IUuTQLkeio0EfyYKqu+VMxax9ttwleeEPnQKJA==` |
| `@openagentsinc/rlm`                       |  34,346 | `5627b53bd1db512710de71cb2ec193c9ea036d7128c90a6cbd7d3fb2e5e9af50` | `sha512-M3JX7BJDvTBbjSltmLD7u5PRl7K1Ytzjvy5HdD/e25Ywixa1fJk0tX3i2DFUBLyJjnNPv4YO4QwosPnu7ILMMQ==` |
| `@openagentsinc/ai-sdk-sandbox-local`      |   9,920 | `5a454c1bc551e305fe534bee9d5fab0a6be9a37c5c3d9dc825f315e4a4a20eeb` | `sha512-DJIWIFD2aogwG81czQRk/jBcZwOJFtv7bca6/+CjjagnCcXgcU1hxodudUkmqUoJ11mzK088OjMkTKaC4bpuZg==` |
| `@openagentsinc/ai-sdk-sandbox-openagents` |   8,840 | `5d08a752e63f1ea9ed9f853cf63cea102b9e22068b774d132e4e1a1f6d01ef7e` | `sha512-SCFlITwn6zSu0uGd1eFd5iFs8WlttY28oInZmxMP+1/z+BoF2DoUrJ3Gl3Nrruol3bnVj48H291oTrUAp7D0Bw==` |
| `@openagentsinc/agent-harness-contract`    | 139,261 | `f034d70e0a89eca158bb7544bda85f1f9bb5a2106fdc423cdd672cbaf6b14494` | `sha512-3vIhogeE/Bbg5LfWKjQ8msCs7T7BB/ivE0Zd1VUVAA5Pz6WCsier6VLFapAhW6NBRnS0brvDhaerPiDBfkRqNQ==` |
| `@openagentsinc/ai-model`                  |  15,568 | `bec40c6909c7bc328130f3385155eb67fe1e7a2f48bba8f150330a3ed4183245` | `sha512-Hww7fkC4As4j1DdW5Ab+BVSAmSK05jibMaYkL5C2MR5dcNs/tjLG6DB70F69qjNZhI9v5Q0nBGcgwfUja7ZuHQ==` |
| `@openagentsinc/graph-corpus`              |  53,659 | `fccdba8aadab96ad00073929258c315589bb6fb17a0b7dcd375f79ae39ec3645` | `sha512-8LFMS/WGvRKYmcst0GpqpLrjRMpWRoQ9aSshJqKPHBTxWdbQI3360y/VBa5YroBz7fEndPnmgJStdyEhDM2C3Q==` |
| `@openagentsinc/history-corpus`            |  27,595 | `03d347c2ad7c88dd92244b61e6e31d8dc4ef474c2ddc871c06cd81782f5070f7` | `sha512-2V9CW86+DMlxmcu9GjUUJj4bnTvj8OP99j64tOM4BJzj76Ci1Z+jT4b291UJyp8l9sYcQpNVcC/ID1pUVCiYcw==` |
| `@openagentsinc/dse`                       |  48,037 | `a2316f11c820151bb703712a458a7138f42ef0367803ab42f730754681868fda` | `sha512-CFsEPBkJbQi/ZL/OQKOGqxahI4GNy9Es2b8p/uXD4xQaIFKm48DS7EtiEbJbLm3l5qXHNpR7D7HEFf6R4ljdHg==` |
| `@openagentsinc/conformance-kit`           |  34,337 | `d889f4473dc1567e1f2d6b37e12ea313333c5f3e9a0024713e28f9e40d5c3832` | `sha512-Hm2JMz1FKTuUNIxr9rEXKZ5RQuVLPZF8/UI2WdTTutt/dkbECjb8g1lpGK6tMJitw/NV0MbEbHK3z8PIqWXHKQ==` |
| `@openagentsinc/ai`                        |   9,551 | `fb77784aa596318ea0d35ff1962a6fa67b01708428d548fce35237cde358a55f` | `sha512-mQN7iOA0EbXL8zwFxJr2hHy23dMivLAhGeJRd8TepjzcBRECKAVQ1fTFOsvr8Ik2g+Bvg2Wxw3mtoX+N7SCC7Q==` |

Publication used the order in this table. It published the runtime and leaf
packages before the umbrella package. All 11 `rc` tags now point to
`0.2.1-rc.2`. No `latest` tag changed.

## External install proof

A new temporary npm project installed all 11 packages from the public registry
by exact version. It imported 16 public entry points, including the graph
ranking, graph archive, and conformance entry points. It then built an empty
owner-scoped graph, encoded it as a 3,305-byte inert archive, imported the
archive, and verified that the graph digest did not change.

This receipt proves package publication and exact-version installation. It does
not prove OpenAgents product adoption, retrieval quality, owner acceptance, or
a public product capability.
