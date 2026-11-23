import { Navigate, useParams } from 'react-router-dom';
import { rememberPendingInvite } from '../lib/pendingInvite';

/**
 * Landing page of an emailed team invite link. It saves the token and goes to
 * the app, which asks the person to accept once they are signed in. Leaving
 * this URL also removes the token from the address bar.
 */
export function AcceptInvite() {
  const { token } = useParams();
  if (token) rememberPendingInvite(token);
  return <Navigate to="/" replace />;
}
