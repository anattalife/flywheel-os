/**
 * Normalize a US phone number to E.164 (+1XXXXXXXXXX). Returns null when it can't.
 * US numbers only: the service runs in the US, and refusing other country codes
 * stops public forms being used to send costly international texts.
 */
export function toE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^\+1\d{10}$/.test(trimmed)) return trimmed;
  if (trimmed.startsWith('+')) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** Names typed into public forms end up inside texts, so they must not carry links. */
export const looksLikeLink = (s: string | null | undefined) => !!s && /(https?:|www\.|\b[a-z0-9-]+\.(com|net|org|io|co|info|biz|xyz|ly|me|link|app|site|top|us)\b|\/\/)/i.test(s);
