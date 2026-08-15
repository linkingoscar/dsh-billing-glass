# dsh-billing-glass — Liquid-Glass Billing Overlay

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.1.0-informational)](#)
[![harness](https://img.shields.io/badge/DeepSeek%20Harness-web%20plugin-6366f1)](#)
[![GitHub](https://img.shields.io/badge/GitHub-linkingoscar%2Fdsh--billing--glass-181717)](https://github.com/linkingoscar/dsh-billing-glass)

English | [中文](README.zh.md)

A billing overlay plugin for the DeepSeek Harness Web GUI: a **liquid-glass** capsule
pinned to the bottom-right corner showing the provider balance; click to expand a full
billing card (session cost, daily spend, token-bucket breakdown, provider list).
**DeepSeek-first**, with an extension point for more API providers.

## Features

- **Always-on glass capsule**: status dot + provider name + balance at a glance; click
  to expand. The expanded card's header is draggable (position stored in localStorage).
  The expanded card automatically avoids the bottom navigation bar and disables
  horizontal overflow — no horizontal scrollbar needed to reach content.
- **Fresh data**: the client polls every 10s; the DeepSeek balance cache TTL is 10s
  (other providers 60s); window focus, tab visibility change and card expansion refresh
  immediately, and the manual refresh button force-bypasses the cache for the current
  provider.
- **Liquid-glass material**: `backdrop-filter` frost + translucent theme colors +
  specular highlight border + refraction sheen layer + soft float shadow; follows the
  `--dsw-*` light/dark theme automatically.
- **Per-message cost badge**: each assistant message's action bar shows a small cost
  chip (hover for the input/cache/output token split and model).
- **Model series tag**: the capsule and card show a short alias for the current model —
  DeepSeek Pro/Flash, Moonshot K2.5/K3, GPT 5.6-Sol/5.6-Terra/5.6-Luna, Claude
  Opus-4, Gemini 2.5-Pro, Qwen 3.7-Max, GLM 5.2; long tags ellipsize instead of
  stretching the card.
- **Spend ledger & stats**: a persistent ledger (`storages/billing-glass-ledger.json`,
  idempotent, debounced atomic writes); the expanded card shows today / this month /
  all-time totals (aggregated in USD, converted to the current provider's currency).
- **Session cost**: every `assistant/message` is priced against the official price
  policy (including the 2026-08-17 peak/valley schedule) and attributed to the provider
  from the `request/header`; full persistent-log replay (including pre-install history)
  + live ledger fallback. Hover ⓘ for the `tokens × unit price = subtotal` formula.
- **Daily spend**: balance-delta estimate (`start-of-day − current`, daily state
  persisted).
- **Pricing sync check (button)**: the card's "plan" row has a **↻ verify pricing**
  button that pulls the official pricing source of **only the currently displayed
  provider** and compares it against the built-in policy chain → ✅ synced / ⚠ drift
  found (details listed, page snapshot saved to
  `storages/billing-glass-pricing-snapshot.html` for the assistant to analyze) /
  unparseable (page changed; guided back to chat). 60s debounce.
- **Multi-provider auto-switching**: the card follows **the provider in current use** —
  the session's latest `request/header` provider > the harness-configured active
  provider (Settings → Models, `agent-default-model`) > the registry's first entry
  (DeepSeek-first). Click any provider in the bottom list to inspect it manually, click
  again to restore auto-follow; the configured active provider carries an "active"
  badge, providers without a configured key a "not configured" marker.
- **Plan / fee system**: each provider declares its `plan` (`token` pay-as-you-go /
  `subscription`); the "plan" row shows the billing mode + the current price tier
  (standard / peak / valley).
- **Daily spend (official, optional)**: by default estimated from the balance delta
  (`≈`). Set `DEEPSEEK_PLATFORM_TOKEN` to switch to official platform data (the exact
  `consumed` value):

  1. Sign in at https://platform.deepseek.com, open DevTools → Console, run
     `JSON.parse(localStorage.getItem('userToken')).value`
  2. Add the result to `~/.dsh/.credentials.yaml`:
     `DEEPSEEK_PLATFORM_TOKEN: <token>`
  3. Refresh the page; the card's daily spend switches to the official figure. Expired
     tokens prompt a re-fetch. Failures fall back to the balance-delta estimate — the
     display never breaks.

## Structure

```
dsh-billing-glass/
├── README.md
├── package.json              # dsh.bundle + dsh.client(web) declaration
├── cordis.patch.yml          # composition patch layer
└── lib/
    ├── index.js              # host: aggregate route /api/billing-glass/state + event pricing
    ├── providers/
    │   ├── registry.js       # provider abstraction & registry (extension point)
    │   ├── deepseek.js       # DeepSeek provider (balance/daily spend/pricing)
    │   └── deepseek-pricing.js # DeepSeek official price engine (policy chain + peak/valley)
    └── client.js             # browser: liquid-glass overlay card (hand-written bundle, no build)
```

## Installation

From GitHub (recommended):

```sh
dsh plugin --profile web add github:linkingoscar/dsh-billing-glass
```

Local checkout (development):

```sh
dsh plugin --profile web add link:$(pwd)
```

Then restart `dsh web` and refresh the page. Requires a harness with the `dsh plugin`
command and a `DEEPSEEK_API_KEY` configured in **Settings → Models** (the balance query
reuses that key; nothing leaves your machine).

## Adding an API provider

**Built-in scope matches the harness official provider list exactly (no setup):**

- The registry ships **25 providers** (`lib/providers/catalog.generated.js`), generated
  by `scripts/sync-providers.js` from the harness's built-in pi-ai official catalog —
  names, baseURLs and per-model official prices (USD/1M) all match the provider list in
  the harness model settings. Whichever provider is chosen in Settings → Models or used
  by a session, the overlay switches automatically.
- DeepSeek uses a dedicated provider (exact peak/valley policy-chain pricing);
  Moonshot / OpenRouter additionally have public balance-endpoint adapters; other
  providers price session cost as usual and show "no public balance endpoint" for the
  balance.
- After a harness upgrade, re-run `node scripts/sync-providers.js` to sync the catalog
  and prices.

**Custom providers outside the official list (graceful degradation + guided loop):**

When a session uses a provider missing from the harness official catalog (baseURL
mismatch), the overlay shows a ⚠ guidance strip:

> Unrecognized provider "xxx": not in the harness official provider list. Tell the
> assistant its pricing scheme (unit prices/subscription) or its official price page in
> chat, and the assistant will wire it up.

Once the user gives a pricing scheme in chat, the generic factory
`defineOpenAiCompatProvider` (`lib/providers/openai-compat.js`) onboards it in one shot —
permanent and automatic from then on.

1. Create `lib/providers/<vendor>.js` implementing the provider contract (see the
   comment at the top of `registry.js`):

   ```js
   export const myVendor = {
     id: "my-vendor",
     displayName: "My Vendor",
     currency: "USD",
     aliases: ["my-vendor-official"],   // harness provider-id aliases (names seen in header/config)
     defaultModel: "my-model",
     keyRef: "MY_VENDOR_API_KEY",       // credential ref (used to detect a configured key)
     plan: { kind: "token", label: "Pay-as-you-go · official prices" },
     // subscription providers:
     // plan: { kind: "subscription", label: "Pro plan", fee: 20, currency: "USD", period: "month" },
     async fetchBalance(ctx) { /* returns { total, granted, toppedUp, available, currency } */ },
     priceAt(model, timeMs) { /* returns { cny, usd, mode } unit price */ },
     costOf(usage, unit) { /* returns { cost, costUsd, ...tokens } */ },
     async todayConsumed(ctx, config, balance) { /* optional, returns number | null */ }
   };
   ```

2. Register it in the `PROVIDERS` array in `registry.js` (order = display order;
   DeepSeek stays first).
3. Pick the provider/model in harness Settings → Models, or make one request through it
   — the overlay switches to show its name, plan and fee system automatically.
4. Restart `dsh web` — the UI and the aggregate route gain a section with no further
   changes.

## Provider-switch signals (auto-detected)

| Signal | Source | Priority |
| --- | --- | --- |
| Provider in actual session use | `request/header` events (provider id or pi-ai gateway baseURL) | highest |
| Configured active provider | `ctx.agentDefaultModel.currentSelection()` (Settings → Models) | next |
| Registry default (DeepSeek) | `PROVIDERS[0]` | fallback |

Provider ids are normalized through `aliases` (e.g. the harness DeepSeek provider id is
`deepseek-official`); the pi-ai gateway matches by baseURL hostname (`baseUrlHosts`,
e.g. `api.moonshot.cn` → Moonshot Kimi); unknown baseURLs are never mis-assigned.

## Verification

```sh
node --check lib/index.js
node --check lib/client.js
node --check lib/providers/*.js
node --test tests/*.mjs               # unit + render smoke + state-route integration
npm pack --dry-run                    # release package contents check
dsh --profile web --dump-config        # composition tree check (the bundle row appears)
# on-device: restart dsh web; the glass capsule appears in the bottom-right corner
```

## License

[Apache-2.0](LICENSE) © 2026 [linkingoscar](https://github.com/linkingoscar)

The pricing engine was ported from
[bpc-oss/dsh-web-billing](https://github.com/bpc-oss/dsh-web-billing) (MIT license);
its copyright notice is retained in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) as required by the MIT terms.
