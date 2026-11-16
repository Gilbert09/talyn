#!/usr/bin/env node
// Sends the newest TestFlight build to Beta App Review when it waits in an external group.
//
// EAS adds each build to the TestFlight groups in the eas.json submit profile. App Store Connect then shows an
// external build as "Ready to Submit": adding a build to a group does not ask Apple for the review. This script asks.
// It looks only at the newest build of the app, so an older build that a newer one replaces never goes to review.
//
// Env: ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY (the .p8 text), ASC_APP_ID.
// Optional: MOBILE_WHAT_TO_TEST, the "What to Test" text for a build that has none.
// Usage: node testflight-review.cjs [--execute]. Without --execute it only prints what it would do.
'use strict';

const crypto = require('node:crypto');

const API = 'https://api.appstoreconnect.apple.com';
const DEFAULT_WHAT_TO_TEST = 'The latest Talyn changes from main. Sign in with GitHub, then try sessions, threads and pull requests.';

/** What to do with the newest build. Pure, so the rules have tests. */
function decide({ processingState, externalBuildState, inExternalGroup }) {
  if (processingState !== 'VALID') return { action: 'wait', reason: `the newest build is ${processingState ?? 'unknown'}` };
  if (!inExternalGroup) return { action: 'skip', reason: 'the newest build is in no external group' };
  if (externalBuildState === 'READY_FOR_BETA_SUBMISSION') return { action: 'submit', reason: 'the newest build is ready to submit' };
  return { action: 'skip', reason: `the newest build is ${externalBuildState ?? 'in an unknown state'}` };
}

function token({ keyId, issuerId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${part({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${part({ iss: issuerId, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' })}`;
  const signature = crypto.sign('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${body}.${signature.toString('base64url')}`;
}

function client(jwt) {
  return async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: { authorization: `Bearer ${jwt}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try { detail = JSON.parse(text).errors.map((e) => `${e.code}: ${e.detail ?? e.title}`).join('; '); } catch { /* keep the raw text */ }
      throw new Error(`${method} ${path.split('?')[0]} answered ${res.status}: ${detail}`);
    }
    return text ? JSON.parse(text) : null;
  };
}

async function main() {
  const execute = process.argv.includes('--execute');
  const env = process.env;
  for (const name of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY', 'ASC_APP_ID']) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  const api = client(token({ keyId: env.ASC_KEY_ID, issuerId: env.ASC_ISSUER_ID, privateKey: env.ASC_PRIVATE_KEY }));
  const app = encodeURIComponent(env.ASC_APP_ID);

  const builds = await api(`/v1/builds?filter[app]=${app}&sort=-uploadedDate&limit=1`
    + '&fields[builds]=version,processingState,buildBetaDetail,betaGroups&include=buildBetaDetail,betaGroups'
    + '&fields[buildBetaDetails]=externalBuildState&fields[betaGroups]=name,isInternalGroup');
  const build = builds.data[0];
  if (!build) return console.log('No builds yet.');
  const included = builds.included ?? [];
  const detail = included.find((item) => item.type === 'buildBetaDetails');
  const groups = included.filter((item) => item.type === 'betaGroups');
  const external = groups.filter((group) => !group.attributes.isInternalGroup);
  const decision = decide({
    processingState: build.attributes.processingState,
    externalBuildState: detail?.attributes.externalBuildState,
    inExternalGroup: external.length > 0,
  });
  console.log(`Build ${build.attributes.version}: ${decision.reason}.`);
  if (decision.action !== 'submit') return;

  const notes = await api(`/v1/builds/${build.id}/betaBuildLocalizations?fields[betaBuildLocalizations]=locale,whatsNew`);
  const hasNotes = notes.data.some((note) => note.attributes.whatsNew?.trim());
  if (!execute) {
    console.log(`Dry run: would ${hasNotes ? '' : 'add "What to Test" and '}send build ${build.attributes.version} to Beta App Review `
      + `for ${external.map((group) => group.attributes.name).join(', ')}.`);
    return;
  }
  if (!hasNotes) {
    const whatsNew = env.MOBILE_WHAT_TO_TEST || DEFAULT_WHAT_TO_TEST;
    const existing = notes.data[0];
    if (existing) {
      await api(`/v1/betaBuildLocalizations/${existing.id}`, {
        method: 'PATCH', body: { data: { type: 'betaBuildLocalizations', id: existing.id, attributes: { whatsNew } } },
      });
    } else {
      await api('/v1/betaBuildLocalizations', {
        method: 'POST',
        body: { data: { type: 'betaBuildLocalizations', attributes: { locale: 'en-US', whatsNew },
          relationships: { build: { data: { type: 'builds', id: build.id } } } } },
      });
    }
    console.log('Added "What to Test".');
  }
  await api('/v1/betaAppReviewSubmissions', {
    method: 'POST', body: { data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } } } },
  });
  console.log(`Sent build ${build.attributes.version} to Beta App Review.`);
}

module.exports = { decide, token };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
