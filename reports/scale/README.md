# Scale benchmark output

Scale benchmark JSON is generated output and is intentionally not versioned. The harness, workload definitions and assertions remain versioned; CI artifacts retain executed evidence.

Run from the repository root with:

```powershell
pnpm benchmark:scale
```

Generated reports are written below `reports/scale/` and are ignored by Git. Results describe only the executed environment and workload; they are not production capacity or service-level guarantees.
