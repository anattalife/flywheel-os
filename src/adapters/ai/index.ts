import { config } from '../../config.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import type { AiChoice, AiProvider } from './types.js';
import { decryptJson } from '../../lib/crypto.js';

let override: ((choice: AiChoice) => AiProvider | null) | undefined;

/**
 * The provider for one business, from its settings.ai choice, falling back to the
 * platform default. Returns null when AI is off: playbooks then use templates.
 */
export function aiFor(settings: { ai?: Partial<AiChoice>; ai_key_sealed?: string } | null | undefined): AiProvider | null {
  const c = config();
  // A business may bring its own API key (stored encrypted); otherwise the platform key is used.
  let ownKey: string | undefined;
  if (settings?.ai_key_sealed) { try { ownKey = decryptJson<{ key: string }>(settings.ai_key_sealed).key; } catch { ownKey = undefined; } }
  const choice: AiChoice = {
    provider: settings?.ai?.provider ?? c.AI_PROVIDER,
    model: settings?.ai?.model ?? c.AI_MODEL,
    fast_model: settings?.ai?.fast_model ?? c.AI_FAST_MODEL,
    base_url: settings?.ai?.base_url ?? c.AI_BASE_URL,
  };
  if (override) return override(choice);
  switch (choice.provider) {
    case 'anthropic': {
      const key = ownKey ?? c.ANTHROPIC_API_KEY;
      if (!key) return null;
      return new AnthropicProvider(key, choice.model!, choice.fast_model ?? choice.model!);
    }
    case 'openai_compatible': {
      if (!choice.base_url) return null;
      // An address the business typed in never receives the platform's key, and must be public HTTPS.
      const own = !!settings?.ai?.base_url && settings.ai.base_url !== c.AI_BASE_URL;
      const key = own ? ownKey : ownKey ?? c.OPENAI_COMPATIBLE_API_KEY;
      return new OpenAiCompatibleProvider(choice.base_url, key, choice.model!, choice.fast_model ?? choice.model!, own);
    }
    default:
      return null;
  }
}

export function setAiFactoryForTests(f: typeof override) { override = f; }
