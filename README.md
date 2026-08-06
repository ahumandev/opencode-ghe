# GitHub Enterprise Copilot plugin

OpenCode plugin for GitHub Enterprise Copilot chat and responses APIs. It replaces a LiteLLM proxy with direct Enterprise Copilot requests.

## Prerequisites, install, build, and test

Requires Bun and an OpenCode installation. From this repository:

```sh
bun install
bun run build
bun run typecheck
bun run test
```

Automated tests are offline by default. Build creates `dist/plugin.js`.

### External package install

```sh
bun add opencode-ghe@0.1.0
```

Log in with native OpenCode auth, then use this `plugin` tuple in `~/.config/opencode/opencode.jsonc`:

```sh
opencode auth login --provider ghe --method "BMW Copilot device login"
```

Complete login. OpenCode manages credentials in its auth storage; do not add a default credential block or token environment variable.

```jsonc
[
  "opencode-ghe",
  {
     "baseUrl": "https://copilot-api.bmw.ghe.com"
  }
]
```

## Local checkout/file install (BMW setup)

Log in before configuring the local plugin:

```sh
opencode auth login --provider ghe --method "BMW Copilot device login"
```

Complete login. OpenCode manages credentials in its auth storage. Manually add this **singular** `plugin` array to `~/.config/opencode/opencode.jsonc` while preserving unrelated settings:

```jsonc
{
  "plugin": [
    [
      "file:///home/me/experimental/opencode-ghe/dist/plugin.js",
      {
         "baseUrl": "https://copilot-api.bmw.ghe.com"
      }
    ]
  ],
  "model": "ghe/claude-sonnet-5"
}
```

BMW proven Sonnet route: POST `https://copilot-api.bmw.ghe.com/chat/completions`.

## Advanced explicit credential fallbacks

Native login is default. As an optional advanced fallback, for an already-exchanged Copilot token set `GHE_COPILOT_TOKEN` in the environment and use this tuple options object:

```jsonc
{
  "baseUrl": "https://copilot-api.bmw.ghe.com",
  "credential": {
    "source": "env",
    "name": "GHE_COPILOT_TOKEN"
  }
}
```

For an optional advanced GitHub OAuth fallback, use an explicit credential reference:

```jsonc
{
  "baseUrl": "https://copilot-api.bmw.ghe.com",
  "credential": {
    "source": "github-oauth"
  }
}
```

Neither fallback is part of default configuration.

## Option reference

The plugin tuple is `["file:///home/me/experimental/opencode-ghe/dist/plugin.js", options]`.

| Option         | Required | Meaning                                                                        |
| -------------- | -------- | ------------------------------------------------------------------------------ |
| `baseUrl`    | Yes      | Absolute Copilot API base URL. Plugin appends request path; do not use`/v1`. |
| `credential` | No       | Advanced explicit`env` token or `github-oauth` credential reference.       |
| `headers`    | No       | Additional allowed request headers.                                            |
| `profiles`   | No       | Optional model profile overrides.                                              |
| `timeoutMs`  | No       | Request timeout in milliseconds.                                               |
| `systemRole` | No       | System-message role override.                                                  |

Unknown option fields are rejected. Native auth credentials are OpenCode-managed; environment configuration holds secret names only.

## Models and capabilities

OpenChamber shows provider **GitHub Enterprise**; Autocode configuration uses provider ID `ghe`. Configure tiers with canonical IDs, not UI labels. See [Autocode configuration](https://ahumandev.github.io/autocode/configuration).

Use short OpenCode model IDs such as `ghe/claude-sonnet-5`. The catalog exposes these seven canonical models:

| UI label         | Catalog ID               | Mode and request path                      | Reasoning budget   |
| ---------------- | ------------------------ | ------------------------------------------ | ------------------ |
| Claude Haiku 4.5 | `ghe/claude-haiku-4.5` | chat — POST`<baseUrl>/chat/completions` | 16000              |
| Claude Sonnet 5  | `ghe/claude-sonnet-5`  | chat — POST`<baseUrl>/chat/completions` | 16000              |
| Claude Opus 4.8  | `ghe/claude-opus-4.8`  | chat — POST`<baseUrl>/chat/completions` | 16000              |
| GPT 5 Mini       | `ghe/gpt-5-mini`       | chat — POST`<baseUrl>/chat/completions` | 16000              |
| GPT 5.4 Mini     | `ghe/gpt-5.4-mini`     | chat — POST`<baseUrl>/chat/completions` | 16000              |
| GPT 5.6 Terra    | `ghe/gpt-5.6-terra`    | responses — POST`<baseUrl>/responses`   | No built-in budget |
| GPT 5.6 Luna     | `ghe/gpt-5.6-luna`     | responses — POST`<baseUrl>/responses`   | No built-in budget |

All seven models support text input, text output, and tools.

BMW LiteLLM reference also lists `gpt-5`, `gpt-5.4`, and `gpt-5.5`; plugin does not expose them because capabilities and routes are unverified. Old `ghe/github_copilot/<model>` requests are compatibility-only, not catalog IDs.

## Verification

Run the safe, no-network smoke check:

```sh
bun run probe -- --model claude-sonnet-5 --base-url https://copilot-api.bmw.ghe.com
```

It does not fetch without `--live`. For an opt-in live contract probe, set `BMW_GHE_TOKEN` to an already-exchanged Copilot token, then run:

```sh
bun run probe -- --model claude-sonnet-5 --base-url https://copilot-api.bmw.ghe.com --live
```

`BMW_GHE_TOKEN` is only for the live probe. Confirm OpenCode selects `ghe/claude-sonnet-5` and the BMW route above. No automated live test suite or environment gate is implied.

## LiteLLM migration

1. Back up current config before editing:
   ```sh
   cp ~/.config/opencode/opencode.jsonc ~/.config/opencode/opencode.jsonc.litellm-backup
   ```
2. Manually remove `provider.litellm` from the config.
3. Run `opencode auth login --provider ghe --method "BMW Copilot device login"`, then manually add the singular native-auth `plugin` tuple from BMW setup and set `model` to `ghe/claude-sonnet-5`.
4. Preserve all unrelated config. Do not automate modification of user config.
5. Build, run offline checks, then use verification steps above.

## Rollback

Restore the backup:

```sh
cp ~/.config/opencode/opencode.jsonc.litellm-backup ~/.config/opencode/opencode.jsonc
```

Or manually remove the `plugin` tuple and selected GHE model, restore prior `provider.litellm` and prior proxy settings, and restore former proxy environment variables. Remove or reset `GHE_COPILOT_TOKEN` and `BMW_GHE_TOKEN` only as required by prior environment setup. Native OpenCode auth remains available for later GHE use.

## Troubleshooting

| Symptom                | Check                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| 401 or 403             | Token type, token validity, and required scopes.                   |
| 404                    | `baseUrl`, request path, model ID, and mode; do not use `/v1`. |
| 429                    | Provider rate limit.                                               |
| 5xx                    | Provider failure. Retry according to provider guidance.            |
| Network or timeout     | Reachability, proxy, DNS, and`timeoutMs`.                        |
| Malformed 2xx response | Provider response contract; retain request ID for support.         |

Use request IDs and safe error classes when reporting problems. Do not include credentials.

## Secret and log policy

Never place tokens, cookies, or cache contents in documentation, config, logs, or fixtures. Use environment variables for values. The probe redacts sensitive material, but review all artifacts before sharing.
