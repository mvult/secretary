import { useEffect, useRef, useState } from 'react';
import type { OutlinePage } from '../outline/types';

/** Only nearby journal cards request bodies; preview reads never select a page. */
export function useJournalPreviews(journals: OutlinePage[], online: boolean,
  load?: (id: string) => Promise<OutlinePage>) {
  const stackRef = useRef<HTMLDivElement>(null);
  const pending = useRef(new Set<string>());
  const mounted = useRef(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [completed, setCompleted] = useState(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setErrors({}); }, [online, load]);
  useEffect(() => {
    if (!online || !load || !stackRef.current || typeof IntersectionObserver === 'undefined') return;
    let active = true;
    const nearby = new Set<string>();
    const pump = () => {
      for (const id of nearby) {
        if (pending.current.size >= 2) break;
        if (pending.current.has(id) || errors[id]) continue;
        nearby.delete(id);
        pending.current.add(id);
        void load(id).catch(error => {
          if (active) setErrors(previous => ({ ...previous, [id]: error instanceof Error ? error.message : 'Could not load journal.' }));
        }).finally(() => {
          pending.current.delete(id);
          if (active) pump();
          // A body may have rendered while this request was still pending.
          if (mounted.current) setCompleted(value => value + 1);
        });
      }
    };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.journalId!;
        if (entry.isIntersecting) nearby.add(id);
        else nearby.delete(id);
      }
      pump();
    }, { rootMargin: '400px' });
    stackRef.current.querySelectorAll('[data-uncached="true"]').forEach(node => observer.observe(node));
    return () => { active = false; observer.disconnect(); };
  }, [journals, online, load, errors, completed]);
  return { stackRef, errors };
}
