# HookRelay development guidance

- Keep business decisions in `packages/core`; AWS and SQLite details belong in adapters.
- Use explicit names and keep shared timing values in `packages/core/policy.ts`.
- Preserve atomic state/outbox writes and version conditions when modifying delivery processing.
- Never describe HTTP delivery as exactly once. The recipient also has to recognize duplicate delivery IDs.
- Keep public-facing copy and the system walkthrough in English. Describe observable service behavior directly.
- Local execution must remain usable without Docker, cloud credentials, or external accounts.
- Run `pnpm check` for logic changes and `pnpm build` for UI/runtime changes. For persistence changes, also run `pnpm test:integration`; for flow changes, `pnpm test:flow`.
- Keep live AWS validation distinct from local SDK and HTTP evidence in `docs/verification.md`.
- Do not log signing keys, API keys, or arbitrary recipient response bodies.
- Do not create or use branches beginning with `codex/`.
