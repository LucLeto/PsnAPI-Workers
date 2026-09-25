import { addSeconds } from './date'

export interface PsnProfile {
  accountId: string
  onlineId: string
  avatar: string | null
}

export interface ProfileResponse {
  profile?: PsnProfile
  invalidAccountId?: boolean
  info: string
}

export interface ApiTokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  refresh_token_expires_in?: number
}

export interface ApiProfileResponse {
  onlineId: string
  avatars?: Array<{ size: string; url: string }>
}

export interface PsnServiceCache {
  accessToken: PsnToken | SerializedPsnToken
  refreshToken: PsnToken | SerializedPsnToken
  // Kept so the worker can exchange it again before the refresh token runs
  // out. Tokens stored before this existed don't have it.
  npsso?: PsnToken | SerializedPsnToken
}

export interface SerializedPsnToken {
  token: string
  created: string
  expire: string
}

export class PsnToken {
  token: string
  created: Date
  expire: Date

  constructor(token: string, created: Date, expire: Date) {
    this.token = token
    this.created = created
    this.expire = expire
  }

  isExpired(): boolean {
    return this.expiresWithin(0)
  }

  expiresWithin(seconds: number): boolean {
    return this.expire.getTime() - seconds * 1000 < Date.now()
  }

  // A refresh can return a new refresh token and lifetime. Both are stored as
  // soon as they're returned, so an extended lifetime is picked up without a
  // code change. Whatever the response leaves out is kept from `previous`.
  static fromTokenResponse(
    response: ApiTokenResponse,
    previous?: PsnToken,
  ): [PsnToken, PsnToken] {
    if (!response.access_token || typeof response.expires_in !== 'number') {
      throw new Error('Missing access token in PSN token response')
    }

    const now = new Date()
    const accessExpire = addSeconds(now, response.expires_in)
    const refreshToken = response.refresh_token ?? previous?.token
    const refreshExpire =
      typeof response.refresh_token_expires_in === 'number'
        ? addSeconds(now, response.refresh_token_expires_in)
        : previous?.expire

    if (!refreshToken || !refreshExpire) {
      throw new Error('Missing refresh token in PSN token response')
    }

    return [
      new PsnToken(response.access_token, now, accessExpire),
      new PsnToken(refreshToken, now, refreshExpire),
    ]
  }

  static deserialize(token: PsnToken | SerializedPsnToken): PsnToken {
    if (token instanceof PsnToken) {
      return token
    }

    const created = new Date(token.created)
    const expire = new Date(token.expire)

    return new PsnToken(token.token, created, expire)
  }
}
