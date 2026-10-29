/**
 * Request paths are logged by the HTTP logger and the error handler. A handoff link puts a bearer token in the path
 * (/handoff/<token>), so anything under /handoff is logged without its token and without its query string.
 */
export function redactPath(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  if (!path.startsWith('/handoff/')) return url;
  const parts = path.split('/'); // ['', 'handoff', '<token>' | 'session', ...rest]
  if (parts[2] && parts[2] !== 'session') parts[2] = '[token]';
  return parts.join('/');
}
