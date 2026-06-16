import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGithubSignature } from '../routes/webhooks.js';

/**
 * The receiver's security model is the HMAC. These cover valid/invalid/missing
 * signatures and that verification is over the exact raw bytes.
 */

const SECRET = 'topsecret';

function sign(body: Buffer | string, secret = SECRET): string {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  return 'sha256=' + createHmac('sha256', secret).update(buf).digest('hex');
}

describe('verifyGithubSignature', () => {
  it('accepts a correct signature', () => {
    const body = Buffer.from(JSON.stringify({ action: 'opened' }));
    expect(verifyGithubSignature(body, sign(body), SECRET)).toBe('valid');
  });

  it('rejects a signature made with the wrong secret', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifyGithubSignature(body, sign(body, 'wrong'), SECRET)).toBe('invalid');
  });

  it('rejects when the body was tampered with after signing', () => {
    const original = Buffer.from('{"a":1}');
    const sig = sign(original);
    const tampered = Buffer.from('{"a":2}');
    expect(verifyGithubSignature(tampered, sig, SECRET)).toBe('invalid');
  });

  it('reports a missing signature header', () => {
    expect(verifyGithubSignature(Buffer.from('x'), undefined, SECRET)).toBe('missing');
  });

  it('rejects a malformed signature of the wrong length without throwing', () => {
    expect(verifyGithubSignature(Buffer.from('x'), 'sha256=deadbeef', SECRET)).toBe('invalid');
  });
});
