import {
  ApiProfileResponse,
  ApiTokenResponse,
  ProfileResponse,
  PsnServiceCache,
  PsnToken,
} from './models'

interface Env {
  TOKEN_STORE?: KVNamespace
  PROFILES_CACHE?: KVNamespace
}

// The PlayStation App's public OAuth client, the same one psn-api uses.
// This is a private API that Sony doesn't support and can change at any time.
const AUTH_BASE_URL = 'https://ca.account.sony.com/api/authz/v3/oauth'
const CLIENT_ID = '09515159-7237-4370-9b40-3806e67c0891'
const CLIENT_AUTHORIZATION =
  'Basic MDk1MTUxNTktNzIzNy00MzcwLTliNDAtMzgwNmU2N2MwODkxOnVjUGprYTV0bnRCMktxc1A='
const REDIRECT_URI = 'com.scee.psxandroid.scecompcall://redirect'
const SCOPE = 'psn:mobile.v2.core psn:clientapp'

const PROFILE_BASE_URL =
  'https://m.np.playstation.com/api/userProfile/v1/internal/users'
const AVATAR_SIZES = ['l', 'xl', 'm', 's']
const INVALID_ACCOUNT_ID_ERROR = 2281473 // "Bad Request (path: accountId)"

const USER_AGENT = 'PsnAPI-Workers'
const TOKEN_STORE_KEY = 'tokens'

// Refresh a little before the access token expires, so it can't expire
// between the check and the profile request.
const ACCESS_TOKEN_REFRESH_MARGIN = 300 // 5 minutes

export class PsnService {
  private readonly requests: string[] = []

  private env: Env
  private accessToken: PsnToken
  private refreshToken: PsnToken

  constructor(env: Env, cache: PsnServiceCache) {
    this.accessToken = PsnToken.deserialize(cache.accessToken)
    this.refreshToken = PsnToken.deserialize(cache.refreshToken)
    this.env = env
  }

  static async create(env: Env): Promise<PsnService> {
    const cached = await requireTokenStore(env).get(TOKEN_STORE_KEY)

    if (!cached) {
      throw new Error('No PSN tokens stored, POST an NPSSO to /admin/npsso')
    }

    return new PsnService(env, JSON.parse(cached))
  }

  // Exchanges the NPSSO straight away and replaces the stored tokens. Returns
  // null when PSN rejects the NPSSO.
  static async fromNpsso(env: Env, npsso: string): Promise<PsnService | null> {
    requireTokenStore(env)

    const code = await exchangeNpssoForCode(npsso)

    if (!code) {
      return null
    }

    const [accessToken, refreshToken] = PsnToken.fromTokenResponse(
      await requestTokens({
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        token_format: 'jwt',
      }),
    )

    const service = new PsnService(env, { accessToken, refreshToken })

    await service.cacheService()

    return service
  }

  get refreshTokenExpire(): Date {
    return this.refreshToken.expire
  }

  async getProfileByAccountId(accountId: string): Promise<ProfileResponse> {
    if (!this.env.PROFILES_CACHE) {
      return this.fetchProfile(accountId) // No cache is available
    }

    const cached = await this.env.PROFILES_CACHE.get(accountId)

    if (cached) {
      return {
        profile: cached === 'null' ? undefined : JSON.parse(cached),
        info: 'Cached profile',
      }
    }

    const res = await this.fetchProfile(accountId)

    if (!res.invalidAccountId) {
      // A failed write, e.g. once the free plan's daily KV write limit is
      // used up, only costs a cache miss next time, so the profile is still
      // returned.
      try {
        await this.env.PROFILES_CACHE.put(
          accountId,
          JSON.stringify(res.profile ?? null),
          {
            expirationTtl: 3600, // 1 hour
          },
        )
      } catch (e) {
        console.error(`Failed to cache profile: ${e}`)
      }
    }

    return res
  }

  // Refreshes the access token even if it's still valid. The daily cron uses
  // this so a broken refresh token shows up without waiting for a request.
  async renew(): Promise<void> {
    await this.refreshAccessToken()
    await this.cacheService()
  }

  private async auth() {
    if (this.accessToken.expiresWithin(ACCESS_TOKEN_REFRESH_MARGIN)) {
      await this.renew()
    }
  }

  private async fetchProfile(accountId: string): Promise<ProfileResponse> {
    await this.auth()

    this.requests.push('fetch')

    const response = await fetch(`${PROFILE_BASE_URL}/${accountId}/profiles`, {
      headers: {
        Authorization: `Bearer ${this.accessToken.token}`,
        'User-Agent': USER_AGENT,
      },
    })

    if (response.status === 404) {
      return { info: '404 response from PSN API' }
    }

    if (!response.ok) {
      const body = await response.text()

      // PSN checks the account ID before the token and rejects IDs it can't
      // parse (e.g. 0, or 2^64 - 1 and up) with this error.
      if (
        response.status === 400 &&
        readErrorCode(body) === INVALID_ACCOUNT_ID_ERROR
      ) {
        return { invalidAccountId: true, info: 'Rejected by PSN API' }
      }

      throw new Error(
        `Invalid status from PSN profile: ${response.status} - ${body}`,
      )
    }

    const json = await response.json<ApiProfileResponse>()

    return {
      profile: {
        accountId,
        onlineId: json.onlineId,
        avatar: pickAvatar(json.avatars),
      },
      info: `Response from PSN API (${this.requests.join(', ')})`,
    }
  }

  private async refreshAccessToken() {
    this.requests.push('refresh')

    const [accessToken, refreshToken] = PsnToken.fromTokenResponse(
      await requestTokens({
        refresh_token: this.refreshToken.token,
        grant_type: 'refresh_token',
        token_format: 'jwt',
        scope: SCOPE,
      }),
      this.refreshToken,
    )

    this.accessToken = accessToken
    this.refreshToken = refreshToken
  }

  private async cacheService(): Promise<void> {
    const tokens: PsnServiceCache = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
    }

    return requireTokenStore(this.env).put(
      TOKEN_STORE_KEY,
      JSON.stringify(tokens),
    )
  }
}

function requireTokenStore(env: Env): KVNamespace {
  if (!env.TOKEN_STORE) {
    throw new Error('TOKEN_STORE KV namespace is not configured')
  }

  return env.TOKEN_STORE
}

// PSN answers a valid NPSSO with a redirect to the app's custom scheme that
// carries the authorization code. A rejected NPSSO redirects without one.
async function exchangeNpssoForCode(npsso: string): Promise<string | null> {
  const params = new URLSearchParams({
    access_type: 'offline',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
  })

  const response = await fetch(`${AUTH_BASE_URL}/authorize?${params}`, {
    headers: {
      Cookie: `npsso=${npsso}`,
      'User-Agent': USER_AGENT,
    },
    redirect: 'manual',
  })

  if (response.status < 300 || response.status >= 400) {
    throw new Error(`Invalid status from PSN authorize: ${response.status}`)
  }

  const location = response.headers.get('location') ?? ''

  if (!location.includes('?code=')) {
    return null
  }

  return new URLSearchParams(location.split('redirect/')[1]).get('code')
}

async function requestTokens(
  body: Record<string, string>,
): Promise<ApiTokenResponse> {
  const response = await fetch(`${AUTH_BASE_URL}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: CLIENT_AUTHORIZATION,
      'User-Agent': USER_AGENT,
    },
    body: new URLSearchParams(body),
  })

  if (!response.ok) {
    throw new Error(
      `Invalid status from PSN token: ${response.status}${await readOAuthError(
        response,
      )}`,
    )
  }

  return response.json<ApiTokenResponse>()
}

// Only a standard OAuth error code (e.g. `invalid_grant`) is reported. The rest
// of a credential endpoint's response never ends up in logs or webhooks.
async function readOAuthError(response: Response): Promise<string> {
  try {
    const json = await response.json<{ error?: unknown }>()

    return typeof json.error === 'string' && /^[a-z_]{1,64}$/.test(json.error)
      ? ` (${json.error})`
      : ''
  } catch {
    return ''
  }
}

function readErrorCode(body: string): number | undefined {
  try {
    return (JSON.parse(body) as { error?: { code?: number } }).error?.code
  } catch {
    return undefined
  }
}

function pickAvatar(avatars: ApiProfileResponse['avatars']): string | null {
  for (const size of AVATAR_SIZES) {
    const avatar = avatars?.find((entry) => entry.size === size)

    if (avatar?.url) {
      return avatar.url
    }
  }

  return null
}
