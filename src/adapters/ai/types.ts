export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface AiRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** 'fast' = small, cheap model for sorting and tagging; 'strong' = anything a customer reads. */
  tier?: 'fast' | 'strong';
}

/** Every model provider sits behind this interface; the operator picks one at setup. */
export interface AiProvider {
  readonly name: string;
  complete(req: AiRequest): Promise<string>;
  /** Answer a question using live web search, when the provider supports it. */
  searchAnswer?(question: string): Promise<string>;
}

/** Per-business choice, stored in businesses.settings.ai */
export interface AiChoice {
  provider: 'anthropic' | 'openai_compatible' | 'none';
  model?: string;
  fast_model?: string;
  base_url?: string;
}
