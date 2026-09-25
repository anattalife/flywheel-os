import type { Tx } from '../db/pool.js';
import type { Business } from '../core/business.js';
import type { AppEvent, EventType } from '../core/events.js';
import type { Pack } from '../packs/schema.js';

export interface PlaybookContext { tx: Tx; business: Business; now: Date }
export type PlaybookKey = keyof Pack['playbooks'];

/**
 * A playbook reacts to events and may schedule its own later steps. All of its
 * timing, wording and trust level come from the business's pack, never from code.
 */
export interface Playbook {
  key: PlaybookKey;
  on: EventType[];
  handle(ctx: PlaybookContext, event: AppEvent): Promise<void>;
  steps?: Record<string, (ctx: PlaybookContext, payload: Record<string, unknown>) => Promise<void>>;
}
