/**
 * Geometry and colours of the badge artwork, shared by the web UI (badge-art.tsx) and the server's SVG export
 * (Open Badges images), so a downloaded badge looks exactly like the one in the app.
 */
import type { BadgeColor } from './completion.js';

/** Gradient (light → deep) and the darker tone used for the rosette edge and ribbons. */
export const BADGE_COLOR_META: Record<BadgeColor, { from: string; to: string; edge: string; label: string }> = {
  gold: { from: '#fcd34d', to: '#d97706', edge: '#b45309', label: 'Gold' },
  silver: { from: '#e2e8f0', to: '#64748b', edge: '#475569', label: 'Silver' },
  bronze: { from: '#f0a868', to: '#9a4a1c', edge: '#7a3a16', label: 'Bronze' },
  indigo: { from: '#a5b4fc', to: '#4f46e5', edge: '#3730a3', label: 'Indigo' },
  violet: { from: '#c4b5fd', to: '#7c3aed', edge: '#5b21b6', label: 'Violet' },
  sky: { from: '#7dd3fc', to: '#0284c7', edge: '#075985', label: 'Sky' },
  teal: { from: '#5eead4', to: '#0d9488', edge: '#115e59', label: 'Teal' },
  emerald: { from: '#6ee7b7', to: '#059669', edge: '#065f46', label: 'Emerald' },
  rose: { from: '#fda4af', to: '#e11d48', edge: '#9f1239', label: 'Rose' },
  fuchsia: { from: '#f0abfc', to: '#c026d3', edge: '#86198f', label: 'Fuchsia' },
};

/** Points of the rosette's serrated edge: a 24-point star around the medal (viewBox 0 0 100 112). */
export const BADGE_ROSETTE_POINTS = Array.from({ length: 48 }, (_, i) => {
  const angle = (Math.PI * i) / 24 - Math.PI / 2;
  const r = i % 2 === 0 ? 45 : 40.5;
  return `${(50 + r * Math.cos(angle)).toFixed(2)},${(48 + r * Math.sin(angle)).toFixed(2)}`;
}).join(' ');

/** The two ribbons below the medal. */
export const BADGE_RIBBON_PATHS = ['M31 78 L22 108 L34 102 L40 111 L47 84 Z', 'M69 78 L78 108 L66 102 L60 111 L53 84 Z'] as const;
