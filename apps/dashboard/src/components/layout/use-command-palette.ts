/** ⌘K / Ctrl+K shortcut; kept apart from the palette so cmdk loads only on first open. */
import { useEffect, useState } from 'react';

export function useCommandPalette() {
  const [open, setOpenState] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const setOpen = (o: boolean | ((prev: boolean) => boolean)) => {
    setOpenState((prev) => {
      const next = typeof o === 'function' ? o(prev) : o;
      if (next) setEverOpened(true);
      return next;
    });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  return { open, setOpen, everOpened };
}
