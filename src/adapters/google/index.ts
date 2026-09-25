import { config } from '../../config.js';
import { GoogleBusinessProfile } from './gbp.js';
import type { GbpReview, GoogleBusinessAdapter, GoogleCreds } from './types.js';

/** Stand-in used in development and tests. */
export class FakeGoogle implements GoogleBusinessAdapter {
  readonly name = 'fake';
  reviews: GbpReview[] = [];
  replies: { reviewId: string; comment: string }[] = [];
  posts: { summary: string; photoUrl?: string; bookUrl?: string }[] = [];
  locations = [{ account: 'accounts/1', location: 'locations/1', title: 'My business' }];
  authUrl(state: string, redirectUri: string) { return `${redirectUri}?code=fake-code&state=${encodeURIComponent(state)}`; }
  async exchangeCode(): Promise<GoogleCreds> { return { refresh_token: 'fake-refresh' }; }
  async accessToken() { return 'fake-token'; }
  async listLocations() { return this.locations; }
  async listReviews() { return this.reviews; }
  async replyToReview(_t: string, _a: string, _l: string, reviewId: string, comment: string) { this.replies.push({ reviewId, comment }); }
  async createPost(_t: string, _a: string, _l: string, post: { summary: string; photoUrl?: string; bookUrl?: string }) { this.posts.push(post); return `localPosts/${this.posts.length}`; }
}

let adapter: GoogleBusinessAdapter | undefined;
export function google(): GoogleBusinessAdapter {
  if (!adapter) {
    const c = config();
    adapter = c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET ? new GoogleBusinessProfile(c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET) : new FakeGoogle();
  }
  return adapter;
}
export function setGoogleAdapter(a: GoogleBusinessAdapter) { adapter = a; }
