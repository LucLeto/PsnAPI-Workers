# PsnAPI Workers

[![Node.js CI](https://github.com/LucLeto/PsnAPI-Workers/actions/workflows/tests.yml/badge.svg)](https://github.com/LucLeto/PsnAPI-Workers/actions/workflows/tests.yml)

A PlayStation Network profile lookup and avatar resizer, built on [Cloudflare Workers](https://workers.cloudflare.com/).

It lets the Darktide mod ProfilePictures show PSN avatars, alongside the [Steam](https://github.com/danreeves/steam-profile-xml-to-json) and [Xbox](https://github.com/danreeves/XboxAPI-Workers) workers.

> [!WARNING]
> PSN has no public profile lookup. This worker uses the PlayStation App's private API, which Sony doesn't support and can change without notice. It signs in with a PSN account, so use a **dedicated burner account**, never a personal one.

## Configuration

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `TOKEN_STORE` | KV namespace | yes | PSN access and refresh tokens |
| `PROFILES_CACHE` | KV namespace | no | Profile responses, cached for one hour |
| `ADMIN_TOKEN` | secret | yes | Protects `POST /admin/npsso` (long random string) |
| `WEBHOOK_URL` | secret | no | Expiry warnings and error alerts (Discord-compatible `{ "content": … }` payload) |

## Installation

* Install dependencies with `npm install`
* Copy `wrangler.example.toml` to `wrangler.toml`
* Create a KV namespace named `TOKEN_STORE` (`npx wrangler kv namespace create TOKEN_STORE`) and add its id in the `wrangler.toml`
* _(Optional)_ Create a KV namespace named `PROFILES_CACHE` and add its id in the `wrangler.toml`
* Set the admin token with `npx wrangler secret put ADMIN_TOKEN` (for example the output of `openssl rand -hex 32`)
* _(Optional)_ Set the webhook with `npx wrangler secret put WEBHOOK_URL`
* Deploy to Workers with `npm run deploy`
* Store the first NPSSO by following the [renewal routine](#renewal-routine-every-2-months)

## Endpoints

### Fetch a profile by account ID

**GET** `/profiles/{accountId}`

`accountId` is the decimal PSN account ID (1–20 digits), as returned by Darktide's `platform_user_id()` for PSN players.

```json
{
  "accountId": "1234567890123456789",
  "onlineId": "Example_Player",
  "avatar": "https://psn-rsc.prod.dl.playstation.net/psn-rsc/avatar/example.png"
}
```

`avatar` is the first size available in the order `l`, `xl`, `m`, `s`, or `null` if the profile has none.

* `400`: the account ID isn't 1–20 digits, or PSN rejects it as invalid
* `404`: unknown account

When `PROFILES_CACHE` is configured, responses (including `404`s) are cached for one hour.

### Resize an avatar

**GET** `/resize?url={avatar}&size={size}`

Returns a 90x100 transparent PNG with the square avatar centred on it at `size` pixels (an integer from 50 to 90, defaults to 90). This is the same output as the Steam and Xbox workers' `/resize`.

`url` must be a percent-encoded avatar URL, otherwise the request is rejected with a `400`:
* protocol `https:` or `http:`
* host `psn-rsc.prod.dl.playstation.net` or `static-resource.np.community.playstation.net`
* no explicit port
* path ending in `.png`, `.jpg` or `.jpeg`

### Replace the stored tokens

**POST** `/admin/npsso`

Requires `Authorization: Bearer {ADMIN_TOKEN}`. The body is `{ "npsso": "…" }`.

The NPSSO is exchanged for tokens straight away, so a bad NPSSO fails here and not on the next profile request.

* `204`: tokens stored
* `400`: body missing `npsso`, or PSN rejected the NPSSO
* `401`: missing or wrong admin token

## Tokens and monitoring

* The access token lasts about an hour. It's refreshed automatically shortly before it expires.
* The refresh token lasts about two months. Every new `refresh_token` and `refresh_token_expires_in` a refresh returns is stored, so if Sony extends the lifetime the worker picks that up without a code change.
* A daily Cron Trigger (12:00 UTC) renews the access token and checks when the refresh token expires. It posts to `WEBHOOK_URL`:
  * when fewer than 7 days are left before the refresh token expires, as a reminder to renew
  * when the daily renewal fails
* Any unhandled error on a request is also posted to `WEBHOOK_URL`.

## Renewal routine (every ~2 months)

Once the refresh token expires, the worker needs a new NPSSO. Getting one means signing in manually. Automating that sign-in is out of scope: it's protected by a CAPTCHA and bot detection, and trying to get around them puts the account and the worker at risk.

1. Sign in to [playstation.com](https://www.playstation.com/) with the burner account.
2. Open <https://ca.account.sony.com/api/v1/ssocookie> and copy the `npsso` value.
3. `POST` it to `/admin/npsso` with the admin token:

   ```bash
   read -rs NPSSO   # paste the npsso, it isn't echoed or saved in the shell history
   curl -X POST "https://<your-worker>/admin/npsso" \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d "{\"npsso\":\"$NPSSO\"}"
   ```

A `204` response means the new tokens are stored.

## Security

* The NPSSO, access token and refresh token are never logged or returned in a response. They're only stored in `TOKEN_STORE`.
* Errors from Sony's sign-in endpoints only report the HTTP status and OAuth error code.
* `/admin/npsso` accepts `POST` only and compares the admin token in constant time.
* `robots.txt` disallows everything.

## To verify before deploying

- [ ] Avatar hosts in real profile responses match the `/resize` allowlist.
- [ ] Which status code the profile API returns for unknown or deleted accounts. The worker maps `404` to `404`. IDs PSN can't parse, like `0` or anything from 2^64 − 1 up, come back as `400` with error code `2281473` and are returned as `400`.
- [ ] Whether refreshing extends `refresh_token_expires_in` or counts it down. Check the daily warning over the first cycle.
- [ ] Rate limits on the profile API, and whether the one-hour cache is enough.
- [ ] Hosting: the `dnrvs.workers.dev` account next to the Steam and Xbox workers, or a separate account.
