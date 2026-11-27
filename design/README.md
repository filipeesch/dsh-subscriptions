# Subscription Hub design

Open the Design preview from this workspace. The entry screen is **Settings → Subscriptions**. Use the breakpoint selector for mobile, tablet, and desktop and the theme selector for light and dark. The screen navigator links directly to the Codex account manager, the pool model allowlist, the reset credits, and the reset confirmation.

The [current client](../src/client/SubscriptionsSection.tsx) owns the provider order and UI behavior. The [quota preferences](../src/client/UsageBadgeDisplaySetting.tsx), [account manager](../src/client/ProviderAccountManager.tsx), and [English UI strings](../src/client/locales.ts) fill in details not shown in the [reference capture](../docs/images/subscriptions.png).

This baseline covers the Subscriptions page, not the rest of Settings, the model picker, or the composer. Accounts and quota readings are fictitious. Controls can be reviewed locally; nothing connects to providers, fetches usage, persists preferences, or spends credits.

The layout preserves the compact controls and scrollable panels of the reference. Layout lint flags controls below 44 px and reports contents past the scroll viewport as overflow or clipped text. The [account management journey](journeys/manage-codex.dsx) and [reset confirmation journey](journeys/review-codex-reset.dsx) exercise the prototype interactions without contacting a provider.
