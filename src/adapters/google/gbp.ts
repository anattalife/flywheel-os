import type { GbpLocation, GbpReview, GoogleBusinessAdapter, GoogleCreds } from './types.js';

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const SCOPE = 'https://www.googleapis.com/auth/business.manage';

async function gfetch<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`google ${res.status}: ${body.error?.message ?? text.slice(0, 200)}`);
  return body as T;
}

export class GoogleBusinessProfile implements GoogleBusinessAdapter {
  readonly name = 'google';
  constructor(private clientId: string, private clientSecret: string) {}

  authUrl(state: string, redirectUri: string) {
    const q = new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent', state });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }

  private async token(params: Record<string, string>) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }),
    });
    const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`google oauth: ${body.error_description ?? res.status}`);
    return body;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<GoogleCreds> {
    const t = await this.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    if (!t.refresh_token) throw new Error('Google did not return a refresh token. Remove the app from your Google account permissions and connect again.');
    return { refresh_token: t.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in ?? 3600) * 1000 };
  }

  async accessToken(creds: GoogleCreds) {
    if (creds.access_token && creds.expires_at && creds.expires_at > Date.now() + 60_000) return creds.access_token;
    const t = await this.token({ grant_type: 'refresh_token', refresh_token: creds.refresh_token });
    creds.access_token = t.access_token!;
    creds.expires_at = Date.now() + (t.expires_in ?? 3600) * 1000;
    return creds.access_token;
  }

  async listLocations(token: string): Promise<GbpLocation[]> {
    const accounts = await gfetch<{ accounts?: { name: string }[] }>('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', token);
    const out: GbpLocation[] = [];
    for (const a of accounts.accounts ?? []) {
      const locs = await gfetch<{ locations?: { name: string; title: string }[] }>(
        `https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title&pageSize=100`, token);
      for (const l of locs.locations ?? []) out.push({ account: a.name, location: l.name, title: l.title });
    }
    return out;
  }

  async listReviews(token: string, account: string, location: string): Promise<GbpReview[]> {
    const loc = location.replace(/^locations\//, '');
    const out: GbpReview[] = [];
    let page: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = await gfetch<{ reviews?: any[]; nextPageToken?: string }>(
        `https://mybusiness.googleapis.com/v4/${account}/locations/${loc}/reviews?pageSize=50${page ? `&pageToken=${page}` : ''}`, token);
      for (const x of r.reviews ?? []) {
        out.push({ id: x.reviewId, reviewer: x.reviewer?.displayName ?? 'A customer', rating: STARS[x.starRating] ?? 0, comment: x.comment ?? null, createdAt: x.createTime, reply: x.reviewReply?.comment ?? null });
      }
      page = r.nextPageToken;
      if (!page) break;
    }
    return out;
  }

  async replyToReview(token: string, account: string, location: string, reviewId: string, comment: string) {
    const loc = location.replace(/^locations\//, '');
    await gfetch(`https://mybusiness.googleapis.com/v4/${account}/locations/${loc}/reviews/${reviewId}/reply`, token, { method: 'PUT', body: JSON.stringify({ comment }) });
  }

  async createPost(token: string, account: string, location: string, post: { summary: string; photoUrl?: string; bookUrl?: string }) {
    const loc = location.replace(/^locations\//, '');
    const body: Record<string, unknown> = { languageCode: 'en-US', topicType: 'STANDARD', summary: post.summary };
    if (post.bookUrl) body.callToAction = { actionType: 'BOOK', url: post.bookUrl };
    if (post.photoUrl) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: post.photoUrl }];
    const r = await gfetch<{ name: string }>(`https://mybusiness.googleapis.com/v4/${account}/locations/${loc}/localPosts`, token, { method: 'POST', body: JSON.stringify(body) });
    return r.name;
  }
}
