/**
 * Badge images for Open Badges: the same rosette art as the web UI's <BadgeArt>, drawn as a standalone SVG,
 * and "baking" (embedding an assertion or credential in the image, per the Open Badges 2.0 and 3.0 baking specs).
 */
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { BADGE_COLOR_META, BADGE_RIBBON_PATHS, BADGE_ROSETTE_POINTS } from '../../../shared/badge-art.js';
import type { BadgeColor, BadgeIcon } from '../../../shared/completion.js';
import { BADGE_ICON_NODES } from './icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
/** Open Badges 2.0 baking namespace. */
export const OB2_BAKING_NS = 'http://openbadges.org';
/** Open Badges 3.0 baking namespace. */
export const OB3_BAKING_NS = 'https://purl.imsglobal.org/ob/v3p0';

/** Characters XML 1.0 can't carry at all, not even as character references (control characters, U+FFFE/U+FFFF, lone surrogates). */
const NOT_XML_CHAR = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function xml(value: string): string {
  return value.replace(NOT_XML_CHAR, '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** The badge as an SVG document (400 px wide by default). */
export function badgeSvg(badge: { icon: BadgeIcon; color: BadgeColor; name: string }, width = 400): string {
  const tone = BADGE_COLOR_META[badge.color] ?? BADGE_COLOR_META.gold;
  const nodes = BADGE_ICON_NODES[badge.icon] ?? BADGE_ICON_NODES.award;
  const icon = nodes
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${xml(v)}"`)
          .join(' ')}/>`,
    )
    .join('');
  return [
    `<svg xmlns="${SVG_NS}" viewBox="0 0 100 112" width="${width}" height="${Math.round(width * 1.12)}">`,
    `<title>${xml(badge.name)}</title>`,
    '<defs>',
    `<linearGradient id="ck-fill" x1="0.2" y1="0" x2="0.8" y2="1"><stop offset="0" stop-color="${tone.from}"/><stop offset="1" stop-color="${tone.to}"/></linearGradient>`,
    `<linearGradient id="ck-ribbon" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${tone.to}"/><stop offset="1" stop-color="${tone.edge}"/></linearGradient>`,
    '</defs>',
    ...BADGE_RIBBON_PATHS.map((d) => `<path d="${d}" fill="url(#ck-ribbon)"/>`),
    `<polygon points="${BADGE_ROSETTE_POINTS}" fill="${tone.edge}" stroke="${tone.edge}" stroke-width="1.5" stroke-linejoin="round"/>`,
    '<circle cx="50" cy="48" r="37" fill="url(#ck-fill)"/>',
    '<circle cx="50" cy="48" r="31" fill="none" stroke="#ffffff" stroke-opacity="0.45" stroke-width="1.5"/>',
    '<ellipse cx="40" cy="30" rx="18" ry="9" fill="#ffffff" opacity="0.18" transform="rotate(-24 40 30)"/>',
    `<svg x="32" y="30" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>`,
    '</svg>',
  ].join('');
}

/**
 * JSON that is safe inside a CDATA section: `<`, `>` and `&` only ever appear inside JSON strings, where the
 * \u escapes mean the same, so the text can never contain "]]>". U+FFFE and U+FFFF are escaped too: XML forbids them,
 * and JSON.stringify already escapes the control characters and lone surrogates.
 */
export function cdataSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&￾￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Bakes Open Badges data into an SVG: the namespace on the root element and a single
 * `<openbadges:assertion>` (2.0) or `<openbadges:credential>` (3.0) element directly after the <svg> tag.
 */
export function bakeSvg(svg: string, bake: { version: 2; verify: string; assertion: unknown } | { version: 3; verify: string }): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root) throw new Error('Badge image is not valid SVG.');
  const ns = bake.version === 2 ? OB2_BAKING_NS : OB3_BAKING_NS;
  root.setAttributeNS(XMLNS_NS, 'xmlns:openbadges', ns);
  const element = doc.createElementNS(ns, bake.version === 2 ? 'openbadges:assertion' : 'openbadges:credential');
  element.setAttribute('verify', bake.verify);
  if (bake.version === 2) element.appendChild(doc.createCDATASection(cdataSafeJson(bake.assertion)));
  root.insertBefore(element, root.firstChild);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(doc)}`;
}
