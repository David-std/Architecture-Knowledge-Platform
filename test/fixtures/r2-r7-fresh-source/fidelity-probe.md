# Fresh Source Fidelity Probe

The Atlas relay publishes retention checkpoint ORCHID-7421 only after reviewer approval.

## Recovery Window

For the Lima staging cluster, the documented Atlas relay recovery target is 17 minutes and the owner is Platform Reliability.

| Service | Region | Recovery target |
| --- | --- | --- |
| Atlas relay | Lima | 17 minutes |
| Boreal cache | Quito | 29 minutes |

## Guardrail

This source records no encryption key for the Atlas relay.
