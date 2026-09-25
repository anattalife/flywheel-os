import { assertPublicHttps } from '../../lib/net.js';
import type { AiProvider, AiRequest } from './types.js';

/**
 * Any provider speaking the OpenAI chat-completions format: OpenAI itself, Google
 * Gemini's OpenAI-compatible endpoint, or a self-hosted open-weight model served by
 * Ollama or vLLM (e.g. http://localhost:11434/v1). No per-message cost when self-hosted.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = 'openai_compatible';
  /** `untrusted`: the address came from a business, not the operator, so it must be public HTTPS. */
  constructor(private baseUrl: string, private apiKey: string | undefined, private model: string, private fastModel: string, private untrusted = false) {}

  async complete(req: AiRequest): Promise<string> {
    if (this.untrusted) await assertPublicHttps(this.baseUrl);
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      redirect: 'error',
      body: JSON.stringify({
        model: req.tier === 'fast' ? this.fastModel : this.model,
        max_tokens: req.maxTokens ?? 400,
        messages: [{ role: 'system', content: req.system }, ...req.messages],
      }),
    });
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message: string } };
    if (!res.ok) throw new Error(`ai ${res.status}: ${body.error?.message ?? 'request failed'}`);
    return (body.choices?.[0]?.message?.content ?? '').trim();
  }
}
