/**
 * One open dropdown at a time across the whole page. Opening a menu announces
 * its ID; every other menu listening for the announcement closes itself.
 */
export const MENU_OPEN_EVENT = 'pluton:menu-open';

export function announceMenuOpen(id: string, target: EventTarget = window) {
   target.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT, { detail: id }));
}

/** Calls `close` when a different menu opens. Returns the unsubscribe function. */
export function onOtherMenuOpen(id: string, close: () => void, target: EventTarget = window) {
   const listener = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) close();
   };
   target.addEventListener(MENU_OPEN_EVENT, listener);
   return () => target.removeEventListener(MENU_OPEN_EVENT, listener);
}
