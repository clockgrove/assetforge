# Developer settings

Developer settings are one per-user file outside every project, and the only input that steers money, code or keys. Shared files (target profile, style bible, presets, recipes) and request inputs travel between developers, so they never name an endpoint, a cap above the settings, a route, a grant or a command. `src/settings.ts` loads the file, `src/formats.ts` checks its format line and `src/env.ts` is the one module that reads the environment.

No command reads settings yet.

## Location

1. `$ASSETGROVE_CONFIG`: an absolute path, and the file must exist.
2. Otherwise `<configHome>/assetgrove/settings.json`, where configHome is `$XDG_CONFIG_HOME` or `~/.config`, and `%APPDATA%` on Windows.

`configDir` is the directory that holds the file. If there is no file, there are no providers, the caps are 5/10/5 USD and the mode is attended.

## Schema

The file is JSON, validated with zod. Every object is strict: an unknown field anywhere is refused.

```jsonc
{
  "format": "assetgrove-settings/1",
  "stateDir": "/abs/path",
  "headless": { "operator": "ci:example/repo" },
  "caps": { "runUsd": 5, "dailyUsd": 10, "workItemUsd": 5 },
  "providers": {
    "<id>": {
      "adapter": "vercel-ai-gateway",
      "keyEnv": "AI_GATEWAY_API_KEY",
      "baseURL": "https://relay.example/v1",
      "free": true,
      "usdPerCredit": 0.01,
      "limit": { "kind": "key-budget", "usd": 20, "period": "monthly", "acceptUnlimited": false },
    },
  },
  "roles": {
    "<role>": { "provider": "<id>", "model": "...", "outputGrant": {}, "providerTerms": "..." },
  },
  "routes": { "<operation>": { "provider": "<id>", "model": "..." } },
  "extensions": ["<package>"],
  "environment": { "allow": ["HTTPS_PROXY"] },
  "reconcile": { "marginUsd": 0.05, "marginPct": 5 },
  "spend": { "acknowledgedHolds": ["<hex>"] },
  "commands": {
    "approved": [
      { "hash": "<hex>", "kind": "validator", "argv": ["..."], "cwd": "tools", "note": "..." },
    ],
  },
  "promptPolicy": { "allow": ["term"] },
  "confirmedBy": { "caps": { "method": "elicitation", "at": "...", "client": "..." } },
}
```

| Field                  | Meaning                                                                                                                                                  | Default                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `format`               | `assetgrove-settings/1`. Required.                                                                                                                       | —                                                                                             |
| `stateDir`             | Absolute directory for run state; never inside a project.                                                                                                | `<stateHome>/assetgrove` (`$XDG_STATE_HOME` or `~/.local/state`; `%LOCALAPPDATA%` on Windows) |
| `headless.operator`    | Present: headless mode, run by this operator. Set only by an operator outside the repository.                                                            | attended                                                                                      |
| `caps`                 | `runUsd`, `dailyUsd`, `workItemUsd`. Shared files may lower them, never raise them.                                                                      | 5 / 10 / 5                                                                                    |
| `providers.<id>`       | `adapter`, `keyEnv` (the variable that holds the key, never the key), `baseURL`, `free`, `usdPerCredit`, `limit`. An entry may hold only `limit`.        | none                                                                                          |
| `providers.<id>.limit` | `kind`: `key-budget`, `team-budget`, `project-hard-limit`, `workspace-limit`, `prepaid` or `unlimited` (needs `acceptUnlimited: true`); `usd`; `period`. | none                                                                                          |
| `roles.<role>`         | `provider`, `model`, `outputGrant` (`license`, `plan`, `commercial`, `relabel`, `attribution`), `providerTerms`.                                         | none                                                                                          |
| `routes.<operation>`   | `provider`, `model`.                                                                                                                                     | none                                                                                          |
| `extensions`           | Packages whose extension code may run.                                                                                                                   | none                                                                                          |
| `environment.allow`    | Refused environment variables (below) that are allowed anyway.                                                                                           | none                                                                                          |
| `reconcile`            | `marginUsd`, `marginPct`.                                                                                                                                | none                                                                                          |
| `spend`                | `acknowledgedHolds`: hex hashes of acknowledged holds.                                                                                                   | none                                                                                          |
| `commands.approved`    | Approved commands: `hash` (hex), `kind`, `argv`, `cwd`, `note`.                                                                                          | none                                                                                          |
| `promptPolicy.allow`   | Prompt-policy allow terms.                                                                                                                               | none                                                                                          |
| `confirmedBy.<path>`   | Who confirmed a field: `method`, `at`, `client`.                                                                                                         | none                                                                                          |

## Refusals

Loading exits 2 with the code `settings_invalid` (`SettingsError`) when:

- the file's real path is inside the Git top level of the cwd, of `--target` or of any input file (case-insensitive on Windows and macOS);
- `$ASSETGROVE_CONFIG` is not absolute or names a missing file;
- the file is not JSON;
- the format is missing, unknown or newer than this build reads;
- any field is unknown;
- any field anywhere is named `apiKey`, `key`, `token` or `secret` (in any case);
- `stateDir` is relative or inside a project;
- a `baseURL` is neither https nor http on a loopback host (`localhost`, `127.0.0.0/8`, `[::1]`);
- `free` is set on a provider without a loopback `baseURL`;
- a role or route names a provider that is not in `providers`;
- a limit of kind `unlimited` lacks `acceptUnlimited: true`.

Refusals that depend on the adapter happen when providers are created.

## Format lines

`readFormat(kind, value, source)` checks `format: "assetgrove-<kind>/<n>"` for `target-profile`, `style-bible`, `style-preset`, `recipe`, `settings` and `blocklist`, all currently at /1. It refuses with `format_unsupported` (`FormatError`), with reason `missing` (the message names the line to add), `too_new` or `unknown`. An older version moves forward in memory through steps registered with `registerMigration(kind, from, migrate)`, and the result reports `migratedFrom`.

## Environment

Only `src/env.ts` reads the environment. `checkEnvironment(allow, env)` refuses with `settings_invalid` when `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY` or `ALL_PROXY` is set, in either case, and `environment.allow` does not list it. Each of these can redirect or unwrap the TLS that carries a key.

## Tests

`test/fixtures/env.ts` writes a settings file to a temporary directory outside any repository and points `ASSETGROVE_CONFIG` at it. Its helpers `writeSettings`, `resetSettings`, `useHeadless`, `approveCommand` and `declareLimit` rewrite that file.
