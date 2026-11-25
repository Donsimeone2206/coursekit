import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getCourseCapabilities, type CourseCapability } from '@shared/permissions';
import type { SessionInfo } from '@shared/types';
import { useEffect } from 'react';
import { api } from './api';
import { contrastText, darkModeTone } from './utils';

export const sessionKey = ['session'] as const;

export function useSession() {
  return useQuery({
    queryKey: sessionKey,
    queryFn: () => api.get<SessionInfo>('/auth/session'),
    staleTime: 60_000,
  });
}

export function useMe() {
  return useSession().data?.user ?? null;
}

export function useSetSession() {
  const qc = useQueryClient();
  return (info: SessionInfo) => {
    qc.setQueryData(sessionKey, info);
  };
}

/**
 * Applies the site's brand colour. Light mode uses it as-is; dark mode uses a lighter tint so
 * brand-coloured text stays readable on dark surfaces (see --brand-* in styles.css).
 */
export function BrandColor() {
  const { data } = useSession();
  const color = data?.site.brandColor;
  useEffect(() => {
    if (!color) return;
    const root = document.documentElement;
    const dark = darkModeTone(color);
    root.style.setProperty('--brand-light', color);
    root.style.setProperty('--brand-light-fg', contrastText(color));
    root.style.setProperty('--brand-dark', dark);
    root.style.setProperty('--brand-dark-fg', contrastText(dark));
  }, [color]);
  return null;
}

export function hasCapability(caps: readonly CourseCapability[] | undefined, cap: CourseCapability) {
  return !!caps?.includes(cap);
}

export { getCourseCapabilities };
