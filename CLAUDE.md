@AGENTS.md

## Docs

Project knowledge lives in `docs/<topic>.md`, each opening with an Overview. Start at `docs/overview.md`. Split a topic into a folder only once it outgrows one file.

- `docs/overview.md`: data flow, doc index, commands
- `docs/valve-model.md`: Valve's model mechanics, quirks and input schema
- `docs/liquipedia-api.md`: Liquipedia API endpoints and data shapes
- `docs/matchdata-pipeline.md`: Liquipedia → matchdata rules, overrides, identity
- `docs/vrs-verification.md`: snapshot windows, details oracle, accuracy, the gate
- `docs/roadmap.md`: next steps

Record decisions in the relevant doc, not in `plans/` (gitignored).
