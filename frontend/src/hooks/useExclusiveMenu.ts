import { RefObject, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { announceMenuOpen, onOtherMenuOpen } from '../utils/exclusiveMenu';

/** Close an open menu on a pointer press outside `ref` or on Escape. */
function useDismiss(open: boolean, ref: RefObject<HTMLElement | null> | undefined, close: () => void) {
   const closeRef = useRef(close);
   useLayoutEffect(() => {
      closeRef.current = close;
   });
   useEffect(() => {
      if (!open) return;
      const pointer = (event: MouseEvent) => {
         if (ref?.current && !ref.current.contains(event.target as Node)) closeRef.current();
      };
      const key = (event: KeyboardEvent) => {
         if (event.key === 'Escape') closeRef.current();
      };
      if (ref) document.addEventListener('mousedown', pointer);
      document.addEventListener('keydown', key);
      return () => {
         document.removeEventListener('mousedown', pointer);
         document.removeEventListener('keydown', key);
      };
   }, [open, ref]);
}

/**
 * Menu-owned open state: opening it closes every other menu on the page, and a
 * press outside `ref` (put it on the element that holds the button and the menu)
 * or Escape closes it.
 */
export function useExclusiveMenu<T extends HTMLElement = HTMLDivElement>() {
   const id = useId();
   const ref = useRef<T>(null);
   const [open, setOpenState] = useState(false);
   const setOpen = useCallback(
      (value: boolean) => {
         setOpenState(value);
         if (value) announceMenuOpen(id);
      },
      [id],
   );
   useEffect(() => onOtherMenuOpen(id, () => setOpenState(false)), [id]);
   useDismiss(open, ref, () => setOpenState(false));
   return { open, setOpen, ref };
}

/**
 * For lists that keep their own "which row menu is open" state: announce when a
 * row menu opens and close it when another menu on the page opens.
 */
export function useExclusiveMenuState(open: boolean, close: () => void, ref?: RefObject<HTMLElement | null>) {
   const id = useId();
   const closeRef = useRef(close);
   useLayoutEffect(() => {
      closeRef.current = close;
   });
   useEffect(() => {
      if (open) announceMenuOpen(id);
   }, [open, id]);
   useEffect(() => onOtherMenuOpen(id, () => closeRef.current()), [id]);
   useDismiss(open, ref, close);
}
