# Remnawave Admin — post-install steps

The app is running, but three things happen outside the cluster:

## 1. First login

Open `https://remnawave-admin.<your-domain>`. The **first login registers the
admin account** — there is no default password. If access is ever lost, the
password resets from the CLI (see upstream
[troubleshooting](https://case211.github.io/remnawave-admin/en/guide/troubleshooting#lost-access-to-the-panel)).

## 2. BotFather domain (required for Telegram login)

Telegram login on the panel only works after the panel domain is registered
with the bot:

1. Open [@BotFather](https://t.me/BotFather) → `/mybots` → your bot
2. Bot Settings → Domain
3. Enter `remnawave-admin.<your-domain>` (HTTPS is served by the cluster)

## 3. Panel notifications (optional)

To have the bot relay panel events (renewals, user changes), point the
Remnawave panel at the bot's in-cluster webhook:

- Webhook URL: `http://remnawave-admin-bot.remnawave-admin.svc.cluster.local:8080/webhook`
  (works when the Remnawave panel runs in the same cluster)
- Secret: the auto-generated `WEBHOOK_SECRET` (Apps → remnawave-admin → Settings)

## 4. Node agents (optional)

Anti-abuse, host metrics, terminal and torrent detection need an agent on each
Remnawave node. The panel builds the install command:
**Servers → Panel nodes → node menu → Agent token → Install agent**.
Agents connect back via WebSocket to `/api/v2/agent/ws` on this panel's public
domain.

## Settings reference

All install questions (bot token, panel API token, admin Telegram IDs, bot
username, panel URL, MaxMind key) live in Apps → remnawave-admin → Settings.
Everything else is changed inside the panel UI without a restart — the panel's
own settings override the environment once set.
