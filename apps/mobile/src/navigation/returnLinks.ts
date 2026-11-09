import { MOBILE_BILLING_RETURN_KINDS, MOBILE_BILLING_RETURN_PATH, MOBILE_BILLING_RETURN_RESULTS } from '@talyn/shared';

/** The path in an app link: `talyn-mobile://github/callback` gives `/github/callback`. */
export function linkPath(url: URL): string {
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.pathname : `/${url.host}${url.pathname}`;
}

/** Only the two return parameters, so nothing else in the link reaches a screen. */
export function billingReturnPath(url: URL): string {
  const kind = url.searchParams.get('kind');
  const result = url.searchParams.get('result');
  const params = new URLSearchParams();
  if (kind && (MOBILE_BILLING_RETURN_KINDS as readonly string[]).includes(kind)) params.set('kind', kind);
  if (result && (MOBILE_BILLING_RETURN_RESULTS as readonly string[]).includes(result)) params.set('result', result);
  const query = params.toString();
  return `/${MOBILE_BILLING_RETURN_PATH}${query ? `?${query}` : ''}`;
}
