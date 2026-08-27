# Open-source checklist

The code boundary, tests, package manifest, and documentation are ready. Before
making this repository public:

- choose and add an explicit license;
- replace placeholder-free package metadata with the final repository URL;
- decide whether publication is Git-source-only or npm;
- keep `private: true` for Git-source-only, or add a compiled `dist` export and
  provenance checks before setting it to `false` for npm;
- run `bun run check` from a clean checkout;
- verify the public history contains no benchmark data, logs, caches, database
  dumps, credentials, sealed plans, or private environment files.

Do not copy Paw's benchmark artifacts into this repository. Publish benchmark
scores as a separate, content-free report bound to an exact source commit.
