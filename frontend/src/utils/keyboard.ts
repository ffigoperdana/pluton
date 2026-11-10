import type { KeyboardEvent } from 'react';

/** Lets Enter or Space activate a non-button element exactly like a mouse click. */
export const onActivateKey = (action: () => void) => (event: KeyboardEvent) => {
   if (event.key !== 'Enter' && event.key !== ' ') return;
   event.preventDefault();
   action();
};
