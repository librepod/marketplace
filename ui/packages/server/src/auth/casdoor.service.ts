import { Injectable, Logger } from '@nestjs/common';
import { SDK } from 'casdoor-nodejs-sdk';

interface UserInfo {
  sub?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
}

@Injectable()
export class CasdoorService {
  private readonly logger = new Logger(CasdoorService.name);
  private readonly sdk: SDK;
  private readonly endpoint: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly orgName: string;
  private readonly appName: string;

  constructor() {
    this.endpoint = (process.env.CASDOOR_ENDPOINT ?? '').replace(/\/$/, '');
    this.clientId = process.env.CASDOOR_CLIENT_ID ?? '';
    this.clientSecret = process.env.CASDOOR_CLIENT_SECRET ?? '';
    this.orgName = process.env.CASDOOR_ORG_NAME ?? '';
    this.appName = process.env.CASDOOR_APP_NAME ?? '';
    // certificate left empty: we do not locally verify the JWT (spec §5.1).
    // NODE_EXTRA_CA_CERTS (set in the deployment) makes axios trust id.<domain>.
    this.sdk = new SDK({
      endpoint: this.endpoint,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      certificate: '',
      orgName: this.orgName,
      appName: this.appName,
    });
  }

  /** Build the Casdoor `/login/oauth/authorize` URL. `host` is the public host
   * the user arrived on (apex or marketplace subdomain) — the callback returns
   * there. Both callback URIs are registered in the SSOClient (Task 8). */
  getAuthorizeUrl(host: string, state: string): string {
    const redirectUri = `https://${host}/api/auth/callback`;
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      state,
    });
    return `${this.endpoint}/login/oauth/authorize?${params.toString()}`;
  }

  /** Exchange an authorization code for the user identity. */
  async exchangeCode(code: string, host: string): Promise<{ sub: string; name: string; email: string }> {
    const redirectUri = `https://${host}/api/auth/callback`;
    const accessToken = await this.getAccessToken(code, redirectUri);
    const info = await this.fetchUserInfo(accessToken);
    return {
      sub: String(info.sub ?? ''),
      name: String(info.preferred_username ?? info.name ?? ''),
      email: String(info.email ?? ''),
    };
  }

  /** SDK-backed token exchange. Signature varies by SDK version — see fallback. */
  protected async getAccessToken(code: string, redirectUri: string): Promise<string> {
    try {
      // Primary path (README-documented). Some versions accept a redirect URI.
      const token = await (this.sdk as any).getAuthToken(code, redirectUri);
      return typeof token === 'string' ? token : token.access_token;
    } catch (err) {
      this.logger.debug(`sdk.getAuthToken failed, falling back to direct POST: ${String(err)}`);
      return this.directTokenPost(code, redirectUri);
    }
  }

  /** Fallback exchange: direct OAuth2 POST to the stable token endpoint. */
  private async directTokenPost(code: string, redirectUri: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    const res = await fetch(`${this.endpoint}/api/login/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error('token response missing access_token');
    return json.access_token;
  }

  /** OIDC userinfo — stable identity shape across SDK versions. */
  protected async fetchUserInfo(accessToken: string): Promise<UserInfo> {
    const res = await fetch(`${this.endpoint}/api/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`userinfo failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as UserInfo;
  }
}
