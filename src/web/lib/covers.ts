import type { CSSProperties } from 'react';

export const COVERS: Record<string, { from: string; to: string; label: string }> = {
  indigo: { from: '#6366f1', to: '#8b5cf6', label: 'Indigo' },
  ocean: { from: '#0ea5e9', to: '#6366f1', label: 'Ocean' },
  emerald: { from: '#10b981', to: '#0d9488', label: 'Emerald' },
  sunset: { from: '#fb923c', to: '#e11d48', label: 'Sunset' },
  rose: { from: '#f43f5e', to: '#a855f7', label: 'Rose' },
  amber: { from: '#f59e0b', to: '#ea580c', label: 'Amber' },
  teal: { from: '#2dd4bf', to: '#0284c7', label: 'Teal' },
  fuchsia: { from: '#e879f9', to: '#7c3aed', label: 'Fuchsia' },
  lime: { from: '#a3e635', to: '#059669', label: 'Lime' },
  slate: { from: '#64748b', to: '#1e293b', label: 'Slate' },
};

export function cover(color: string) {
  return COVERS[color] ?? COVERS.indigo!;
}

export function coverStyle(color: string, imageUrl?: string | null): CSSProperties {
  const c = cover(color);
  if (imageUrl) {
    return {
      backgroundImage: `linear-gradient(180deg, rgb(0 0 0 / 0.05), rgb(0 0 0 / 0.45)), url("${imageUrl}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    };
  }
  return {
    backgroundImage: [
      'radial-gradient(circle at 85% 15%, rgb(255 255 255 / 0.35), transparent 38%)',
      'radial-gradient(rgb(255 255 255 / 0.14) 1px, transparent 1px)',
      `linear-gradient(135deg, ${c.from} 0%, ${c.to} 100%)`,
    ].join(', '),
    backgroundSize: 'auto, 14px 14px, auto',
  };
}

export function coverDot(color: string): CSSProperties {
  const c = cover(color);
  return { backgroundImage: `linear-gradient(135deg, ${c.from}, ${c.to})` };
}
