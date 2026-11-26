/** Content types for files served from packages, by extension. Unknown types are served as downloads. */
const TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  xml: 'application/xml',
  xsd: 'application/xml',
  txt: 'text/plain',
  csv: 'text/csv',
  vtt: 'text/vtt',
  srt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  swf: 'application/x-shockwave-flash',
  zip: 'application/zip',
};

export function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return (path.includes('.') && TYPES[ext]) || 'application/octet-stream';
}

export function isHtml(path: string): boolean {
  const type = mimeFor(path);
  return type === 'text/html' || type === 'application/xhtml+xml';
}
