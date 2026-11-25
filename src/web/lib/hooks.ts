import { useEffect, useRef, useState } from 'react';
import { useSession } from './session';

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/** Sets the browser tab title: "Page · Site name". */
export function useTitle(title: string | null | undefined) {
  const { data } = useSession();
  const site = data?.site.name ?? 'Coursekit';
  useEffect(() => {
    document.title = title ? `${title} · ${site}` : site;
  }, [title, site]);
}

/** Re-renders every `ms` milliseconds (for countdowns and relative times). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Warn before leaving the page with unsaved changes. */
export function useUnsavedChanges(dirty: boolean) {
  const ref = useRef(dirty);
  ref.current = dirty;
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (ref.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
}
