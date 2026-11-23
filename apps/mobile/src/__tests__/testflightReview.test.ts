import crypto from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decide, token } = require('../../scripts/testflight-review.cjs');

describe('testflight review', () => {
  it.each([
    ['a processing build waits', { processingState: 'PROCESSING', externalBuildState: 'PROCESSING', inExternalGroup: true }, 'wait'],
    ['a failed build waits', { processingState: 'FAILED', externalBuildState: undefined, inExternalGroup: true }, 'wait'],
    ['a build with no external group is skipped', { processingState: 'VALID', externalBuildState: 'READY_FOR_BETA_SUBMISSION', inExternalGroup: false }, 'skip'],
    ['a ready build is submitted', { processingState: 'VALID', externalBuildState: 'READY_FOR_BETA_SUBMISSION', inExternalGroup: true }, 'submit'],
    ['a build missing compliance is skipped', { processingState: 'VALID', externalBuildState: 'MISSING_EXPORT_COMPLIANCE', inExternalGroup: true }, 'skip'],
    ['a build in review is skipped', { processingState: 'VALID', externalBuildState: 'WAITING_FOR_BETA_REVIEW', inExternalGroup: true }, 'skip'],
    ['an approved build is skipped', { processingState: 'VALID', externalBuildState: 'IN_BETA_TESTING', inExternalGroup: true }, 'skip'],
    ['an unknown state is skipped', { processingState: 'VALID', externalBuildState: undefined, inExternalGroup: true }, 'skip'],
  ])('%s', (_name, input, action) => expect(decide(input).action).toBe(action));

  it('signs an ES256 token that the public key verifies', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwt = token({ keyId: 'KEY', issuerId: 'ISSUER', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), now: 1000 });
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ iss: 'ISSUER', iat: 1000, exp: 2200, aud: 'appstoreconnect-v1' });
    expect(crypto.verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'))).toBe(true);
  });
});
