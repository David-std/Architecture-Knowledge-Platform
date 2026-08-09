# Vault schema gap report

| Gap                        |            Count/state | Treatment                                                          |
| -------------------------- | ---------------------: | ------------------------------------------------------------------ |
| Duplicate copied raw IDs   |            formerly 35 | raw paths now receive synthetic IDs; operational IDs remain stable |
| Unresolved wikilinks       |                    100 | warning and no edge; human repair remains optional                 |
| Acquisition/backlog copies |                      6 | archived/unverified and excluded from normal retrieval             |
| Explicit dependency edges  |                    262 | compiled as 211 `derives_from`, 51 `requires`                      |
| Ambiguous wikilinks        |                    930 | preserved as low-authority `related_to`                            |
| Non-node taxonomy tags     | present (`applies_to`) | not forced into document relations                                 |
| Git revision               | absent in source vault | deterministic snapshot revision                                    |

The remaining 100 links must not be “fixed” by guessing. A future reviewed vault migration may resolve them with human context.
