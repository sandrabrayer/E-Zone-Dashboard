'use strict';
// Body-only credentials. Google's redirect serves the precomputed response;
// credentials must never follow a redirect, including a 307/308 replay.
async function crmPost(url, body) {
  const target = new URL(url);
  if (target.origin !== 'https://script.google.com' || !/^\/macros\/s\/[^/]+\/exec$/.test(target.pathname) ||
      target.username || target.password || target.search || target.hash) throw Error('crm_not_configured');
  const signal = AbortSignal.timeout(20000);
  let r = await fetch(target.href, { method: 'POST', redirect: 'manual', cache: 'no-store', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if ([302, 303].includes(r.status)) {
    const next = new URL(r.headers.get('location'), target);
    if (next.origin !== 'https://script.googleusercontent.com' || next.username || next.password) throw Error('crm_source_unavailable');
    r = await fetch(next.href, { method: 'GET', redirect: 'error', cache: 'no-store', signal });
  }
  if (!r.ok) throw Error('crm_source_unavailable');
  return r.json();
}
module.exports = { crmPost };
