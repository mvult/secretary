import { useEffect, useState } from 'react';

/** Debounce presentation only; persistence never waits for this timer. */
export function useSaveStatus(key: string, message: string, urgent: boolean) {
  const [displayed, setDisplayed] = useState({ key, message });

  useEffect(() => {
    if (urgent || displayed.key !== key) {
      setDisplayed({ key, message });
      return;
    }
    const timer = window.setTimeout(() => setDisplayed({ key, message }), 3500);
    return () => window.clearTimeout(timer);
  }, [key, message, urgent, displayed.key]);

  // Never show the previous document/account's status while switching pages.
  return urgent || displayed.key !== key ? message : displayed.message;
}
