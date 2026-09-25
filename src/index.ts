import type { IRequest } from 'itty-router'

import { Router, error, text } from 'itty-router'
import { type Rgb, flattenPng } from './png'
import { PsnService } from './psn/service'
import { usageAlerts } from './usage'

export interface Env {
  TOKEN_STORE?: KVNamespace
  PROFILES_CACHE?: KVNamespace
  ADMIN_TOKEN?: string
  WEBHOOK_URL?: string
  CF_ACCOUNT_ID?: string
  CF_API_TOKEN?: string
}

// Avatars are served by PSN's resource hosts, so only those can be resized.
// Anything else would turn /resize into an open image proxy.
const AVATAR_HOSTS = new Set([
  'psn-rsc.prod.dl.playstation.net',
  'static-resource.np.community.playstation.net',
])
const AVATAR_EXTENSION = /\.(?:png|jpe?g)$/i
const RESIZE_CANVAS_WIDTH = 90
const RESIZE_CANVAS_HEIGHT = 100
const RESIZE_SIZE_RANGE: [number, number] = [50, RESIZE_CANVAS_WIDTH]
const TRANSPARENT_CANVAS_URL =
  'https://placehold.co/90x100/transparent/transparent.png'
// Black blends into the dark portrait frames best, community feedback preferred
// it over the green the unflattened images used to show
const DEFAULT_RESIZE_BACKGROUND = '000000'

const DAY_MS = 24 * 60 * 60 * 1000
const RENEWAL_WARNING_DAYS = 7
const RENEWAL_STEPS =
  'Sign in to playstation.com with the burner account in your own browser, copy `npsso` from https://ca.account.sony.com/api/v1/ssocookie and run `npm run post-npsso -- <worker URL>`. ' +
  'Full routine: https://github.com/LucLeto/PsnAPI-Workers#renewal-routine-every-60-days'

// Must match the usage check's cron in wrangler.toml. Any other cron runs the
// daily renewal, so that one keeps working if its time is changed.
const USAGE_CHECK_CRON = '*/15 * * * *'

const router = Router()

router
  .get('/profiles/:accountId', handleProfileRequest)
  .get('/resize', handleResizeRequest)
  .post('/admin/npsso', handleNpssoRequest)
  .get('/robots.txt', () => text('User-agent: *\nDisallow: /'))
  .all('*', () => error(404))

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return router.handle(request, env, ctx).catch(async (e: Error) => {
      console.error(e.toString())

      await sendWebhook(env, `An error occurred on ${request.url}: \`${e}\``)

      return error(500, `Internal server error: ${e}`)
    })
  },

  scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(
      controller.cron === USAGE_CHECK_CRON
        ? handleUsageCheck(env, new Date(controller.scheduledTime))
        : handleScheduled(env),
    )
  },
}

async function handleProfileRequest(request: IRequest, env: Env) {
  const accountId = request.params?.accountId

  if (!accountId || !/^\d{1,20}$/.test(accountId)) {
    return error(400, 'Invalid account ID format')
  }

  const service = await PsnService.create(env)
  const response = await service.getProfileByAccountId(accountId)

  if (response.invalidAccountId) {
    return error(400, `Invalid account ID (${response.info})`)
  }

  if (!response.profile) {
    return error(404, `User '${accountId}' not found (${response.info})`)
  }

  return Response.json(response.profile)
}

// Same layout as the Steam and Xbox workers' /resize: a 90x100 PNG with the
// square avatar centred at `size` pixels, so it can fill a rectangular
// portrait without being stretched. The portrait frame material ignores
// transparency, so the padding and any transparent parts of the avatar are
// the `background` colour.
async function handleResizeRequest(request: IRequest) {
  const { searchParams } = new URL(request.url)
  const source = searchParams.get('url')

  if (!source) {
    return error(400, 'Missing image URL')
  }

  let imageUrl: URL

  try {
    imageUrl = new URL(source)
  } catch {
    return error(400, 'Invalid image URL')
  }

  if (
    (imageUrl.protocol !== 'https:' && imageUrl.protocol !== 'http:') ||
    !AVATAR_HOSTS.has(imageUrl.hostname) ||
    imageUrl.port !== '' ||
    !AVATAR_EXTENSION.test(imageUrl.pathname)
  ) {
    return error(400, 'Disallowed image URL')
  }

  const size = parseResizeSize(searchParams.get('size'))

  if (size === null) {
    return error(400, `Invalid size [${RESIZE_SIZE_RANGE.join('-')}]`)
  }

  const background = parseBackground(searchParams.get('background'))

  if (background === null) {
    return error(400, 'Invalid background [RRGGBB]')
  }

  const resized = await fetch(TRANSPARENT_CANVAS_URL, {
    cf: {
      image: {
        width: RESIZE_CANVAS_WIDTH,
        height: RESIZE_CANVAS_HEIGHT,
        format: 'png',
        draw: [
          {
            url: imageUrl.toString(),
            width: size,
            height: size,
            fit: 'contain',
            left: Math.floor((RESIZE_CANVAS_WIDTH - size) / 2),
            top: Math.floor((RESIZE_CANVAS_HEIGHT - size) / 2),
          },
        ],
      },
    },
  })

  if (!resized.ok || resized.headers.get('Content-Type') !== 'image/png') {
    return resized
  }

  const png = new Uint8Array(await resized.arrayBuffer())
  let body: Uint8Array = png

  // A PNG that can't be flattened is still returned as Cloudflare made it
  try {
    body = await flattenPng(png, background)
  } catch (e) {
    console.error(`Failed to flatten the resized image: ${e}`)
  }

  return new Response(body, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control':
        resized.headers.get('Cache-Control') ?? 'public, max-age=86400',
    },
  })
}

function parseResizeSize(value: string | null): number | null {
  if (value === null) {
    return RESIZE_CANVAS_WIDTH
  }

  const size = Number(value)

  if (
    !Number.isInteger(size) ||
    size < RESIZE_SIZE_RANGE[0] ||
    size > RESIZE_SIZE_RANGE[1]
  ) {
    return null
  }

  return size
}

// Six hex digits without a `#`, which would start the URL fragment
function parseBackground(value: string | null): Rgb | null {
  const hex = value ?? DEFAULT_RESIZE_BACKGROUND

  if (!/^[0-9a-f]{6}$/i.test(hex)) {
    return null
  }

  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ]
}

async function handleNpssoRequest(request: IRequest, env: Env) {
  if (!isAdminRequest(request, env)) {
    return error(401, 'Unauthorized')
  }

  let body: { npsso?: unknown } | null

  try {
    body = await request.json()
  } catch {
    return error(400, 'Invalid JSON body')
  }

  const npsso = body?.npsso

  if (typeof npsso !== 'string' || npsso === '') {
    return error(400, 'Missing npsso')
  }

  const service = await PsnService.fromNpsso(env, npsso)

  if (!service) {
    return error(400, 'NPSSO was rejected by PSN')
  }

  return new Response(null, { status: 204 })
}

// Constant-time comparison, so the admin token can't be recovered from
// response timings. Without a configured ADMIN_TOKEN every request is refused.
function isAdminRequest(request: IRequest, env: Env): boolean {
  if (!env.ADMIN_TOKEN) {
    return false
  }

  const encoder = new TextEncoder()
  const expected = encoder.encode(`Bearer ${env.ADMIN_TOKEN}`)
  const actual = encoder.encode(request.headers.get('Authorization') ?? '')

  return (
    expected.byteLength === actual.byteLength &&
    crypto.subtle.timingSafeEqual(expected, actual)
  )
}

async function handleScheduled(env: Env) {
  let service: PsnService | undefined

  try {
    service = await PsnService.create(env)
    await service.renew()
  } catch (e) {
    console.error(`${e}`)

    await sendWebhook(
      env,
      `Daily token renewal failed: \`${e}\`\n${RENEWAL_STEPS}`,
    )
  }

  if (!service) {
    return
  }

  // The worker renews its tokens from the stored NPSSO on its own, so a manual
  // renewal is only needed before the NPSSO expires
  const { what, expire } = service.renewalDeadline
  const remaining = expire.getTime() - Date.now()

  if (remaining >= RENEWAL_WARNING_DAYS * DAY_MS) {
    return
  }

  const status =
    remaining > 0
      ? `expires in ${Math.floor(remaining / DAY_MS)} day(s) (${expire.toISOString()})`
      : `expired on ${expire.toISOString()}`

  await sendWebhook(env, `The PSN ${what} ${status}.\n${RENEWAL_STEPS}`)
}

async function handleUsageCheck(env: Env, now: Date) {
  for (const message of await usageAlerts(env, now)) {
    await sendWebhook(env, message)
  }
}

// Alerting must never mask the original error, so failures are only logged.
// The webhook URL is a secret too, so the fetch error itself isn't logged.
async function sendWebhook(env: Env, content: string) {
  if (typeof env.WEBHOOK_URL !== 'string') {
    return
  }

  try {
    await fetch(env.WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-type': 'application/json',
      },
      body: JSON.stringify({
        content: `**PsnAPI Workers** ${content}`,
      }),
    })
  } catch {
    console.error('Failed to send webhook')
  }
}
