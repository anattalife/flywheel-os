import type { AiProvider, AiRequest } from './types.js';

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  constructor(private apiKey: string, private model: string, private fastModel: string) {}

  async complete(req: AiRequest): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.tier === 'fast' ? this.fastModel : this.model,
        max_tokens: req.maxTokens ?? 400,
        system: req.system,
        messages: req.messages,
      }),
    });
    const body = (await res.json()) as { content?: { type: string; text?: string }[]; error?: { message: string } };
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${body.error?.message ?? 'request failed'}`);
    return (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  }

  /** Uses Anthropic's server-side web search tool, the way an assistant answering a customer would. */
  async searchAnswer(question: string): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model, max_tokens: 1200,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        messages: [{ role: 'user', content: question }],
      }),
    });
    const body = (await res.json()) as { content?: { type: string; text?: string }[]; error?: { message: string } };
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${body.error?.message ?? 'request failed'}`);
    return (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  }
}
