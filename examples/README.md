# Examples

These scripts demonstrate the library's public surface without requiring a real
connectome fixture (`.flt` / `.flw`). For the full end-to-end pipeline, see
`04-createTrainer.ts` — it requires you to point at exported `meta.bin` and
`weights-*.flw` files from the browser app.

## Run

The library has already been built into `../dist/`. Run each script via Node
24+ (uses stable type-stripping):

```bash
node --experimental-strip-types --no-warnings examples/01-encoder.ts
node --experimental-strip-types --no-warnings examples/02-decoder-policy.ts
node --experimental-strip-types --no-warnings examples/03-persist.ts
FIXTURES_DIR=./exports node --experimental-strip-types --no-warnings examples/04-createTrainer.ts
```

## What's in each file

| File | Demonstrates |
|------|--------------|
| `01-encoder.ts` | `FlyEncoder.encode()` — three canonical state shapes |
| `02-decoder-policy.ts` | `FlyDecoder` rolling window + `trainedFlapRequest` safety rails + `onlineLearningThreshold` warm-up curve + `inferReadout` |
| `03-persist.ts` | `freshModel` / `cloneModel` / `validateModel` / `modelToJson` + `modelFromJson` |
| `04-createTrainer.ts` | Full pipeline (requires fixtures) |