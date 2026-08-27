# dsh-billing-glass — Liquid-Glass Billing Overlay

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![version](https://img.shields.io/badge/version-0.4.2-informational)](#)
[![harness](https://img.shields.io/badge/DSH-community%20plugin-6366f1)](#)
[![GitHub](https://img.shields.io/badge/GitHub-linkingoscar%2Fdsh--billing--glass-181717)](https://github.com/linkingoscar/dsh-billing-glass)

English | [中文](README.zh.md)

> 社区第三方插件，与 DeepSeek 官方无隶属关系 · Unofficial community plugin, not affiliated with or endorsed by DeepSeek.

<p align="center">
  <img src="docs/assets/dsh-billing-expanded.png" alt="Expanded billing card / 展开态计费卡" width="260" />
  <img src="docs/assets/dsh-billing-capsule.png" alt="Capsule / 胶囊态" width="150" />
</p>

A billing overlay plugin for the DeepSeek Harness Web GUI: a **liquid-glass** capsule
pinned to the bottom-right corner showing the provider balance; click to expand a full
billing card (session cost, daily spend, token-bucket breakdown, provider list).
**DeepSeek-first**, with an extension point for more API providers.

## Features

- **Always-on glass capsule**: status dot + provider name + balance at a glance; click
  to expand. The expanded card's header is draggable (position stored in localStorage;
  it can be dragged anywhere on the page with no bottom dead zone). The card disables
  horizontal overflow — no horizontal scrollbar needed to reach content.
- **Fresh data**: the client polls every 10s; the DeepSeek balance cache TTL is 10s
  (other providers 60s); official daily spend is cached for 5 minutes; window focus, tab
  visibility change and card expansion refresh immediately, and the manual refresh button
  force-refreshes the current provider balance via POST.
- **Liquid-glass material**: `backdrop-filter` frost + translucent theme colors +
  specular highlight border + refraction sheen layer + soft float shadow; follows the
  `--dsw-*` light/dark theme automatically.
- **Per-message cost badge**: each assistant message's action bar shows a small cost
  chip (hover for the input/cache/output token split and model).
- **Settings card**: a "Billing capsule" page in the settings panel
  (Harness v0.1.0-rc.7+; hidden automatically on older hosts): toggle the glass
  capsule / per-message cost chips, and reset the card position in one click.
  Changes apply instantly and stay in the local browser only.
- **Model series tag**: the capsule and card show a short alias for the current model —
  DeepSeek Pro/Flash/Flash-Vision, Moonshot K2.5/K3, GPT 5.6-Sol/5.6-Terra/5.6-Luna,
  Claude Opus-4, Gemini 2.5-Pro, Qwen 3.7-Max, GLM 5.2; long tags ellipsize instead of
  stretching the card.
- **Spend ledger & stats**: an append-only JSONL ledger
  (`storages/billing-glass-ledger.jsonl`, idempotent, debounced appends, periodic
  compaction; the legacy `billing-glass-ledger.json` is migrated automatically; bad
  lines and partial tails are detected at startup, repaired and surfaced as a degraded
  warning). The expanded card shows today / this month / all-time totals, bucketed by the
  browser's IANA timezone so a UTC server does not shift the day boundary. `costUsd` is
  the only aggregation base; display uses `costNative + nativeCurrency` — the ambiguous
  single `cost` field is gone.
- **Session cost**: every `assistant/message` is priced against the official price
  policy (validity windows included, plus the 2026-08-17 peak/valley schedule). The
  experimental vision model `deepseek-v4-flash-vision-exp` (shipped in Harness
  v0.1.1-rc.1) is priced exactly like v4-flash (images are billed as size-converted
  tokens). Live and replay share one canonical attribution pipeline (header > source)
  and are merged with messageId dedupe; full persistent-log replay (including
  pre-install history) + live fallback; hosts whose persistence backend has no
  per-session raw artifacts degrade to live-only automatically. Hover ⓘ for the
  `tokens × unit price = subtotal` formula.
- **Unknown models fail closed**: a model missing from the catalog (catalog lag, alias
  rename, brand-new model) is never silently priced at zero — the message is marked
  unpriced, the card and spend stats expose `unpricedCalls: N`, and the ledger stores
  `priced: false`.
- **Daily spend (official only)**: the row appears only when
  `DEEPSEEK_PLATFORM_TOKEN` is configured. Without it the row is hidden — a
  balance-delta estimate would be confused by top-ups/refunds, so it is no longer a
  display source.
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
- **Daily spend (official, optional)**: without `DEEPSEEK_PLATFORM_TOKEN` the row is
  hidden. With it, the card shows the exact official `consumed` value:

  1. Sign in at https://platform.deepseek.com, open DevTools → Console, run
     `JSON.parse(localStorage.getItem('userToken')).value`
  2. Add the result to `~/.dsh/.credentials.yaml`:
     `DEEPSEEK_PLATFORM_TOKEN: <token>`
  3. Refresh the page; the card's "today consumed" row appears with the official
     figure. Expired tokens or API failures hide the row rather than falling back to a
     misleading balance-delta estimate.

## Known limitations

- **"Daily spend" is official-only**: the row is hidden unless
  `DEEPSEEK_PLATFORM_TOKEN` is configured. A balance-delta estimate is no longer
  displayed because top-ups/refunds make it unreliable.
- **Peak windows are weekdays-only per the official page as of 2026-08-23**: the
  official footnote defines peak hours as Mon–Fri 9:00–12:00 / 14:00–18:00 Beijing
  time (weekends are all off-peak). The page did not spell this out between
  2026-08-17 and 08-22; replay stats use the current definition, so replayed amounts
  for those days may be slightly below the real bill if the platform billed daily
  peak/valley back then.
- **Session cost and spend stats are locally computed, not a provider invoice**: they
  are priced from the plugin's built-in official price tables and message tokens, and
  may differ slightly from the final platform bill (pricing moment, rounding,
  peak/valley interpretation).
- **Spend stats only cover messages the plugin has seen**: the current session can be
  replayed from the persistent session log (including pre-install history), but other
  historical sessions that the plugin never processed are not in the local ledger.
- **Unknown models fail closed**: a model missing from the catalog is marked unpriced
  rather than priced at zero, so displayed totals may understate the real bill; re-run
  `scripts/sync-providers.js` or provide a pricing scheme to close the gap.
- **Some providers have no public balance endpoint**: their balance shows "—", though
  session cost is still priced from the catalog.
- **The price catalog can lag**: non-DeepSeek prices come from the harness built-in
  pi-ai catalog snapshot; re-run `scripts/sync-providers.js` after harness upgrades.
  DeepSeek can be checked on demand with the "verify pricing" button.
- **DeepSeek historical pricing only covers audited windows**: policies carry
  `[since, until]`; unaudited gaps and retired aliases (`deepseek-chat`/`deepseek-reasoner`)
  are marked unpriced instead of inheriting old prices forever.
- **Official daily spend uses the Beijing day boundary** (Asia/Shanghai), independent of
  the host/server timezone.
- **The model series tag is a display heuristic**: brand-new model names may show no
  tag or a generic one; it never affects pricing.
- **Balance freshness has latency**: DeepSeek balances refresh at most every 10s (other
  providers 60s), and the provider's own balance settlement may lag further.

## Structure

```
dsh-billing-glass/
├── README.md
├── package.json              # dsh.bundle + dsh.client(web) declaration
├── cordis.patch.yml          # composition patch layer
├── scripts/
│   ├── build-client.js       # src/client/* → lib/client.js (install still needs no build)
│   ├── sync-providers.js     # pi-ai catalog sync + provenance recording
├── src/client/               # maintainable browser source (component/format/model-badge/prefs/settings)
└── lib/
    ├── index.js              # host: aggregate route /api/billing-glass/state + event pricing
    ├── ledger.js             # append-only JSONL spend ledger
    ├── client.js             # build artifact (edit src/client, then run the build)
    └── providers/
        ├── registry.js       # provider abstraction & registry (extension point)
        ├── deepseek.js       # DeepSeek provider (balance/daily spend/pricing)
        ├── deepseek-pricing.js # DeepSeek official price engine (policy chain + peak/valley)
        └── catalog.generated.js # pi-ai snapshot + PI_AI_CATALOG_META provenance
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

## Security / trust boundary

- On dsh v0.1.2+, every plugin route reuses the host connection's launch-token and
  Host/Origin checks. On v0.1.1 the compatibility fallback retains the legacy trust
  boundary, so keep the harness `webServer` localhost-bound or behind host auth.
- `GET /api/billing-glass/state` and `GET /api/billing-glass/ledger` are read-only
  (balance/today external fetches are TTL-cached, so UI polling cannot amplify them).
- Side-effecting routes are **POST**: `/api/billing-glass/refresh-balance` (force-refresh
  a provider balance) and `/api/billing-glass/refresh-pricing` (fetch the official price
  page and possibly write a snapshot).
- The DeepSeek platform token is only used host-side against the platform's internal
  usage endpoint, and today-consumed results are cached for 5 minutes.

## Adding an API provider

**Built-in scope matches the harness official provider list exactly (no setup):**

- The registry ships **27 providers** (`lib/providers/catalog.generated.js`), generated
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
- Catalog provenance is auditable: `catalog.generated.js` exports
  `PI_AI_CATALOG_META` (source / sourceVersion / sourceSha256 / generatedAt), written
  automatically by the sync script and enforced non-null by CI.

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
     // must return null when the model is unknown and no `*` fallback exists (fail closed)
     priceAt(model, timeMs) { /* returns { cny, usd, mode } unit price, or null */ },
     // costNative is the provider-native amount; costUsd is the aggregation base
     costOf(usage, unit) { /* returns { costNative, nativeCurrency, costUsd, ...tokens } */ },
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
npm ci                               # locked devDependency (pi-ai catalog sync)
npm test                             # unit + render smoke + state-route integration
npm run check:generated              # rebuild client bundle + rerun catalog sync, then git-diff verify
npm run pack:check                   # release package contents check
dsh --profile web --dump-config        # composition tree check (the bundle row appears)
# on-device: restart dsh web; the glass capsule appears in the bottom-right corner
```

CI (`.github/workflows/ci.yml`) runs the same gates on every push/PR.

## License

[Apache-2.0](LICENSE) © 2026 [linkingoscar](https://github.com/linkingoscar)

The pricing engine was ported from
[bpc-oss/dsh-web-billing](https://github.com/bpc-oss/dsh-web-billing) (MIT license);
its copyright notice is retained in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) as required by the MIT terms.
