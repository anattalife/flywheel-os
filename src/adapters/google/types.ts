export interface GoogleCreds { refresh_token: string; access_token?: string; expires_at?: number }
export interface GbpLocation { account: string; location: string; title: string }
export interface GbpReview { id: string; reviewer: string; rating: number; comment: string | null; createdAt: string; reply: string | null }

/** Google Business Profile, behind an interface so tests and development don't call Google. */
export interface GoogleBusinessAdapter {
  readonly name: string;
  authUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<GoogleCreds>;
  /** Returns a usable access token, refreshing when needed (creds are updated in place). */
  accessToken(creds: GoogleCreds): Promise<string>;
  listLocations(token: string): Promise<GbpLocation[]>;
  listReviews(token: string, account: string, location: string): Promise<GbpReview[]>;
  replyToReview(token: string, account: string, location: string, reviewId: string, comment: string): Promise<void>;
  createPost(token: string, account: string, location: string, post: { summary: string; photoUrl?: string; bookUrl?: string }): Promise<string>;
}
