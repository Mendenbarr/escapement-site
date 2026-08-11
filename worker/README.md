# escapement-signup worker

Newsletter signup backend for escapementgame.com. Double opt-in capture only —
broadcasts are sent manually (list export below) until scale demands tooling.

- `POST /subscribe` — form fields `email`, `ref` (optional source tag), `website`
  (honeypot, must be empty), `js=1` for a JSON reply instead of a redirect.
  Rate limits: 3 signups per IP per 10 minutes, 90 confirmation emails per day
  (Resend free tier is 100/day).
- `GET /confirm?t=<token>` — confirms, redirects to the site.
- `GET /unsubscribe?t=<token>` — unsubscribes, shows a plain page. Include
  this link (with the subscriber's token) in every manual broadcast.

## First deploy

```
wrangler d1 create escapement_newsletter   # paste database_id into wrangler.toml
wrangler d1 execute escapement_newsletter --remote --file=schema.sql
wrangler secret put RESEND_API_KEY         # paste the Resend sending-only key
wrangler deploy                            # note the workers.dev URL
```

Then set the form `action` in `../index.html` to `<worker-url>/subscribe`.

## Export the confirmed list

```
wrangler d1 execute escapement_newsletter --remote --command "SELECT email, token, ref, confirmed_at FROM subscribers WHERE confirmed_at IS NOT NULL AND unsubscribed_at IS NULL" --json
```

The `token` column builds each subscriber's unsubscribe link:
`<worker-url>/unsubscribe?t=<token>`.

Sender identity: `newsletter@updates.escapementgame.com` (Resend-verified
subdomain), replies go to `hello@escapementgame.com`.
