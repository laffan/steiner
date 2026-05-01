/**
 * Event-bus shim. In the Tauri build this is a thin pass-through to
 * `@tauri-apps/api/event`. In the web build it's an in-page emitter so that
 * code paths which rely on Rust-emitted events (e.g. `ask-done`,
 * `session-updated`) keep working when the renderer also produces those
 * events itself (see web-api.ts).
 *
 * The signatures intentionally mirror the Tauri ones so callers don't need
 * to branch on IS_TAURI.
 */

import { IS_TAURI } from "./runtime";

export interface BusEvent<T> {
  payload: T;
}

export type BusHandler<T> = (event: BusEvent<T>) => void;
export type Unlisten = () => void;

const handlers = new Map<string, Set<BusHandler<unknown>>>();

export async function listen<T>(
  event: string,
  handler: BusHandler<T>,
): Promise<Unlisten> {
  if (IS_TAURI) {
    const mod = await import("@tauri-apps/api/event");
    return mod.listen<T>(event, handler);
  }
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(handler as BusHandler<unknown>);
  return () => {
    set!.delete(handler as BusHandler<unknown>);
  };
}

/**
 * Synchronous in-page emit. Only used by the web backend to mimic Rust-side
 * events. Calling this from the Tauri backend is a no-op for that build's
 * Rust→JS events (those are dispatched through the Tauri runtime instead).
 */
export function emit<T>(event: string, payload: T): void {
  const set = handlers.get(event);
  if (!set) return;
  for (const h of set) {
    try {
      (h as BusHandler<T>)({ payload });
    } catch (err) {
      console.error(`[steiner] listener for "${event}" threw`, err);
    }
  }
}
