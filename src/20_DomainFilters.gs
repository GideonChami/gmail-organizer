/**
 * DOMAIN FILTERS: one filter per brand domain ("from:shop.example") that labels EVERY address at that domain,
 * including low-volume senders that never got their own filter and any new address the brand starts using.
 *
 * Built from the senders you ticked in "Senders". A domain is SKIPPED (stays on per-address filters) when:
 *   - its ticked senders use different labels (e.g. example.com: Shopping/Example vs Newsletters)
 *   - its label is the retention label (Newsletters are auto-deleted; never extended to a whole domain)
 *   - it is personal mail, a government domain, or listed in DOMAIN_EXCLUDE (shared sending platforms)
 * Domain filters only ADD a label. They never skip the inbox: a new address at a domain might be important.
 * Per-address filters that become redundant (same label, no skip-inbox) are removed, but only after a search
 * confirms the domain filter actually matches that sender's mail.
 */

/** READ-ONLY: shows every domain filter that would be created, what it would label, and what it would replace. */
function previewDomainFilters() { runDomainFilters_(true); }

/** Creates the domain filters, labels existing mail, removes redundant per-address filters. Resumable. */
function applyDomainFilters() { runDomainFilters_(false); }

function runDomainFilters_(preview) {
  const t0 = Date.now();
  const props = PropertiesService.getScriptProperties();
  const done = new Set((props.getProperty(CFG.P.DOMAINS) || '').split(',').filter(Boolean));
  const plan = openSS_().getSheetByName('Senders').getDataRange().getValues().slice(1);
  const cand = domainCandidates_(plan);
  const labelIds = labelIdMap_();
  const filters = Gmail.Users.Settings.Filters.list('me').filter || [];

  let created = 0, removed = 0, labeled = 0, newMsgs = 0;
  Logger.log((preview ? '[PREVIEW] ' : '') + cand.ok.length + ' domain filters, ' + cand.skipped.length + ' domains skipped');

  for (const c of cand.ok) {
    if (done.has(c.domain)) { Logger.log('already done: ' + c.domain); continue; }
    if (Date.now() - t0 > CFG.MAX_RUNTIME_MS) { Logger.log('Time limit reached - run again to continue.'); break; }

    const id = labelIds[c.label] || '';
    const all = messageIdsFrom_(c.domain);
    const allSet = new Set(all);
    const already = id ? new Set(messageIds_({ labelIds: [id], q: 'from:"' + c.domain + '"' })) : new Set();
    const toLabel = all.filter(x => !already.has(x));
    const exists = filters.some(f => String((f.criteria || {}).from || '').toLowerCase() === c.domain &&
                                     (((f.action || {}).addLabelIds) || [])[0] === id);

    // per-address filters made redundant: same single label, no skip-inbox, nothing else in criteria/action,
    // and the domain search really finds that sender's mail
    const emails = new Set(c.senders.map(s => s.email));
    const redundant = filters.filter(f => {
      const cr = f.criteria || {}, ac = f.action || {};
      const from = String(cr.from || '').toLowerCase();
      if (!emails.has(from) || Object.keys(cr).length !== 1) return false;
      if ((ac.addLabelIds || []).length !== 1 || ac.addLabelIds[0] !== id) return false;
      if ((ac.removeLabelIds || []).length || ac.forward) return false;
      const sample = messageIds_({ q: 'from:"' + from + '"', maxResults: 20 }, 1);
      return sample.length > 0 && sample.every(x => allSet.has(x));
    });

    Logger.log((preview ? '[PREVIEW] ' : '') + c.domain + ' -> ' + c.label +
               ' | ticked senders: ' + c.senders.length + ' | messages: ' + all.length +
               ' (newly labeled: ' + toLabel.length + ')' +
               ' | per-address filters replaced: ' + redundant.length + (exists ? ' | filter exists' : ''));
    newMsgs += toLabel.length;
    if (preview) continue;

    const labelId = ensureLabel_(c.label, labelIds);
    if (!exists) {
      Gmail.Users.Settings.Filters.create({ criteria: { from: c.domain }, action: { addLabelIds: [labelId] } }, 'me');
      created++;
    }
    for (let j = 0; j < toLabel.length; j += 1000) {
      Gmail.Users.Messages.batchModify({ ids: toLabel.slice(j, j + 1000), addLabelIds: [labelId] }, 'me');
    }
    labeled += toLabel.length;
    redundant.forEach(f => { Gmail.Users.Settings.Filters.remove('me', f.id); removed++; });
    done.add(c.domain);
    props.setProperty(CFG.P.DOMAINS, Array.from(done).join(','));
  }

  Logger.log('--- skipped domains (stay on per-address filters) ---');
  cand.skipped.forEach(s => Logger.log('  ' + s));
  Logger.log(preview
    ? '[PREVIEW] Messages that would gain a label: ' + newMsgs + '. Nothing was changed.'
    : 'Domain filters created: ' + created + ', messages labeled: ' + labeled + ', per-address filters removed: ' + removed);
}

/** Groups ticked senders by registrable domain and decides which domains can get one filter. */
function domainCandidates_(plan) {
  const ticked = plan.filter(r => r[0] === true && String(r[1] || '').indexOf('@') > 0 && String(r[8] || '').trim());
  const groups = {};
  ticked.forEach(r => {
    const email = String(r[1]).trim().toLowerCase();
    const dom = regDomain_(email.split('@')[1]);
    (groups[dom] = groups[dom] || []).push({ email, label: String(r[8]).trim() });
  });

  const ok = [], skipped = [];
  Object.keys(groups).sort().forEach(dom => {
    const g = groups[dom];
    const labels = Array.from(new Set(g.map(x => x.label)));
    let why = '';
    if (dom.indexOf('.') < 0) why = 'no domain';
    else if (FREE_MAIL.has(dom)) why = 'personal mail';
    else if (DOMAIN_EXCLUDE.has(dom)) why = 'in DOMAIN_EXCLUDE';
    else if (GOVERNMENT_DOMAINS.test(dom)) why = 'government domain';
    else if (labels.length > 1) why = 'mixed labels: ' + labels.join(' / ');
    else if (labels[0] === RETENTION.LABEL) why = RETENTION.LABEL + ' (auto-deleted, not extended to whole domains)';
    else {
      const clash = ticked.find(r => {
        const e = String(r[1]).toLowerCase();
        return String(r[8]).trim() !== labels[0] && (e.endsWith('.' + dom) || e.endsWith('@' + dom));
      });
      if (clash) why = 'conflicts with ' + clash[1];
    }
    if (why) skipped.push(dom + ' - ' + why);
    else ok.push({ domain: dom, label: labels[0], senders: g });
  });
  return { ok, skipped };
}
