/**
 * PIPELINE: scan -> analyze -> plan.
 * startScan() and analyze() only write to the spreadsheet. previewPlan() changes nothing. applyPlan() changes Gmail.
 */

/* ============================ 1. SCAN ============================ */

/** Reads metadata of every message into the "Raw" sheet (resumes itself via a trigger). Changes nothing in Gmail. */
function startScan() {
  const p = PropertiesService.getScriptProperties();
  let ss;
  if (p.getProperty(CFG.P.SS)) {
    ss = SpreadsheetApp.openById(p.getProperty(CFG.P.SS));
  } else {
    ss = SpreadsheetApp.create(CFG.SPREADSHEET_NAME);
    ss.getActiveSheet().setName('Raw');
    p.setProperty(CFG.P.SS, ss.getId());
  }
  const raw = ss.getSheetByName('Raw') || ss.insertSheet('Raw');
  raw.clearContents();   // fresh scan; analyze() keeps your edits in "Senders"
  raw.getRange(1, 1, 1, 9).setValues([['id', 'threadId', 'date', 'email', 'name', 'domain', 'unsub', 'labelIds', 'subject']]);
  raw.setFrozenRows(1);

  p.setProperty(CFG.P.TOKEN, '');
  p.setProperty(CFG.P.COUNT, '0');
  p.setProperty(CFG.P.STATUS, 'Running');
  Logger.log('Spreadsheet: ' + ss.getUrl());
  scanBatch();
}

function resumeScan() {
  PropertiesService.getScriptProperties().setProperty(CFG.P.STATUS, 'Running');
  scanBatch();
}

function stopScan() {
  deleteTriggers_('scanBatch');
  PropertiesService.getScriptProperties().setProperty(CFG.P.STATUS, 'Stopped');
}

function scanBatch() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { schedule_('scanBatch', 60000); return; }
  try {
    const p = PropertiesService.getScriptProperties();
    if (p.getProperty(CFG.P.STATUS) !== 'Running') return;
    deleteTriggers_('scanBatch');

    const sheet = openSS_().getSheetByName('Raw');
    const t0 = Date.now();
    let token = p.getProperty(CFG.P.TOKEN) || undefined;
    let count = Number(p.getProperty(CFG.P.COUNT) || 0);
    let done = false;

    while (Date.now() - t0 < CFG.MAX_RUNTIME_MS) {
      const res = Gmail.Users.Messages.list('me', {
        q: CFG.QUERY, maxResults: 500, pageToken: token, fields: 'messages/id,nextPageToken'
      });
      const ids = ((res && res.messages) || []).map(m => m.id);
      const rows = fetchMeta_(ids);
      appendRows_(sheet, rows);                    // write first...
      count += rows.length;
      token = res ? res.nextPageToken : undefined;
      p.setProperty(CFG.P.TOKEN, token || '');     // ...then advance the checkpoint
      p.setProperty(CFG.P.COUNT, String(count));
      Logger.log('Scanned ' + count + ' messages (' + Math.round((Date.now() - t0) / 1000) + 's)');
      if (!token || (CFG.SAMPLE_LIMIT && count >= CFG.SAMPLE_LIMIT)) { done = true; break; }
    }

    if (done) {
      p.setProperty(CFG.P.STATUS, 'Completed');
      Logger.log('SCAN COMPLETE: ' + count + ' messages. Now run analyze().');
    } else {
      schedule_('scanBatch', 5000);
    }
  } catch (e) {
    if (/quota|rate limit|429|userRateLimit/i.test(String(e.message))) {
      Logger.log('Quota hit - pausing 2 minutes, then continuing automatically.');
      schedule_('scanBatch', 2 * 60 * 1000);
      return;
    }
    PropertiesService.getScriptProperties().setProperty(CFG.P.STATUS, 'Error');
    Logger.log('ERROR: ' + e.message + ' -> run resumeScan() to continue');
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/** Parallel metadata fetch with exponential backoff on 429/5xx. */
function fetchMeta_(ids) {
  const token = ScriptApp.getOAuthToken();
  const base = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/';
  const qs = '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe' +
             '&fields=id,threadId,internalDate,labelIds,payload/headers';
  const out = [];
  for (let i = 0; i < ids.length; i += CFG.PARALLEL) {
    let chunk = ids.slice(i, i + CFG.PARALLEL);
    for (let attempt = 0; chunk.length && attempt < 6; attempt++) {
      const resps = UrlFetchApp.fetchAll(chunk.map(id => ({
        url: base + id + qs, headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
      })));
      const retry = [];
      resps.forEach((r, j) => {
        const c = r.getResponseCode();
        if (c === 200) out.push(parseMeta_(JSON.parse(r.getContentText())));
        else if (c !== 404) retry.push(chunk[j]);
      });
      chunk = retry;
      if (chunk.length) Utilities.sleep(1000 * Math.pow(2, attempt));
    }
  }
  return out;
}

function parseMeta_(m) {
  const h = {};
  ((m.payload && m.payload.headers) || []).forEach(x => { h[x.name.toLowerCase()] = x.value; });
  const from = h['from'] || '';
  const em = from.match(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i);
  const email = em ? em[0].toLowerCase() : from.toLowerCase();
  const name = from.replace(/<.*>/, '').replace(/"/g, '').trim();
  return [
    m.id, m.threadId, new Date(Number(m.internalDate)), email, name,
    email.split('@')[1] || '', h['list-unsubscribe'] ? 1 : 0,
    (m.labelIds || []).join(','), (h['subject'] || '').slice(0, 100)
  ];
}

function appendRows_(sheet, rows) {
  if (!rows.length) return;
  const start = sheet.getLastRow() + 1;
  const need = start + rows.length;
  if (need > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), need - sheet.getMaxRows() + 2000);
  sheet.getRange(start, 1, rows.length, 9).setValues(rows);
}

/* ============================ 2. ANALYZE ============================ */

const SENDERS_HEAD = ['Apply', 'Sender', 'Name', 'Domain', 'Messages', 'Last message', 'Unsub %', 'Gmail tab',
                      'Suggested label', 'Skip inbox', 'Status', 'Sample subject', 'Added'];

/**
 * Groups "Raw" by sender and rebuilds the "Senders" sheet.
 * KEEPS YOUR EDITS: for senders already in the sheet, Apply / Suggested label / Skip inbox / Status are kept.
 * New senders get today's date in "Added" so you can filter for them.
 */
function analyze() {
  const ss = openSS_();
  const me = Gmail.Users.getProfile('me').emailAddress.toLowerCase();
  const raw = ss.getSheetByName('Raw');
  const data = raw.getLastRow() > 1 ? raw.getRange(2, 1, raw.getLastRow() - 1, 9).getValues() : [];

  const seen = new Set(), by = {};
  let total = 0;
  data.forEach(r => {
    if (seen.has(r[0])) return; seen.add(r[0]); total++;
    const email = String(r[3] || '').toLowerCase(); if (!email || email === me) return;
    const s = by[email] || (by[email] = { email, name: r[4], domain: r[5], n: 0, unsub: 0, last: 0, cats: {}, subj: [] });
    s.n++; s.unsub += r[6] ? 1 : 0;
    const d = new Date(r[2]).getTime(); if (d > s.last) s.last = d;
    String(r[7]).split(',').forEach(l => { if (l.indexOf('CATEGORY_') === 0) s.cats[l] = (s.cats[l] || 0) + 1; });
    if (s.subj.length < 6) s.subj.push(r[8]);
  });

  const prev = readSenders_(ss);
  const known = knownLabels_();
  const today = new Date();
  const senders = Object.keys(by).map(k => by[k]).sort((a, b) => b.n - a.n);
  const rows = [];
  let covered = 0, added = 0, autoTicked = 0;

  senders.forEach(s => {
    const cat = Object.keys(s.cats).sort((a, b) => s.cats[b] - s.cats[a])[0] || '';
    const label = classify_(s, cat, known);
    const row = [false, s.email, s.name, s.domain, s.n, new Date(s.last), Math.round(100 * s.unsub / s.n) + '%',
                 cat.replace('CATEGORY_', ''), label,
                 SKIP_INBOX_LABELS.indexOf(label) >= 0 && !NEVER_SKIP.test(s.email), '', s.subj[0] || '', ''];
    const old = prev[s.email];
    if (old) {                       // keep your decisions
      row[0] = old[0] === true; row[8] = old[8]; row[9] = old[9] === true; row[10] = old[10]; row[12] = old[12] || '';
      delete prev[s.email];
    } else {                         // brand-new sender
      row[0] = s.n >= CFG.MIN_COUNT && label !== 'Review' && autoTicked < CFG.MAX_FILTERS;
      row[12] = today; added++;
    }
    if (row[0]) { covered += s.n; autoTicked++; }
    rows.push(row);
  });
  // senders that were in the sheet but have no mail left: keep their row (and decisions) at the bottom
  Object.keys(prev).forEach(email => rows.push(prev[email]));

  let sh = ss.getSheetByName('Senders');
  if (sh) ss.deleteSheet(sh);
  sh = ss.insertSheet('Senders');
  sh.getRange(1, 1, 1, SENDERS_HEAD.length).setValues([SENDERS_HEAD]).setFontWeight('bold');
  if (rows.length) {
    sh.getRange(2, 1, rows.length, SENDERS_HEAD.length).setValues(rows);
    sh.getRange(2, 1, rows.length, 1).insertCheckboxes();
    sh.getRange(2, 10, rows.length, 1).insertCheckboxes();
  }
  sh.setFrozenRows(1);
  sh.getRange(1, 1, rows.length + 1, SENDERS_HEAD.length).createFilter();   // whole table, not just the header

  Logger.log('Messages analyzed: ' + total + ' | unique senders: ' + senders.length + ' | NEW senders: ' + added);
  Logger.log('Ticked senders cover ' + Math.round(100 * covered / Math.max(total, 1)) + '% of your mail');
  Logger.log('Review new rows (filter "Added" = today), then run previewPlan(). ' + ss.getUrl());
}

/** Current "Senders" rows keyed by lowercase email, padded to 13 columns. */
function readSenders_(ss) {
  const sh = ss.getSheetByName('Senders');
  const map = {};
  if (!sh || sh.getLastRow() < 2) return map;
  const w = Math.min(SENDERS_HEAD.length, sh.getMaxColumns());
  sh.getRange(2, 1, sh.getLastRow() - 1, w).getValues().forEach(r => {
    const email = String(r[1] || '').trim().toLowerCase();
    if (!email) return;
    while (r.length < SENDERS_HEAD.length) r.push('');
    r[1] = email;
    map[email] = r;
  });
  return map;
}

function classify_(s, cat, known) {
  const marketing = s.unsub / s.n > 0.6;

  // 0. Personal mailboxes and explicit sender rules
  if (FREE_MAIL.has(s.domain)) return 'Review';
  for (const [re, label, always] of SENDER_RULES) {
    if (re.test(s.email) && (always || !marketing)) return label;
  }

  // 1. Sender domain matches a label you already have -> reuse it
  const root = rootOf_(s.domain);
  if (known[root]) return known[root];

  // 2. Category rules (sender + name + subjects)
  const text = (s.email + ' ' + s.name + ' ' + s.subj.join(' ')).toLowerCase();
  for (const r of RULES) {
    if (r.commerce && marketing) continue;
    if (!r.re.test(text)) continue;
    if (!r.merchant) return r.label;
    const m = merchant_(s);
    if (!m) return r.label;
    return known[m.toLowerCase()] || (r.label + '/' + m);
  }

  // 3. Fallbacks
  if (marketing) return 'Newsletters';
  if (CATEGORY_FALLBACK[cat]) return CATEGORY_FALLBACK[cat];
  return 'Review';
}

function rootOf_(domain) {
  const p = String(domain || '').toLowerCase().split('.');
  return p.length > 2 && p[p.length - 2].length <= 3 ? p[p.length - 3] : (p[p.length - 2] || p[0]);
}

/** Merchant name from display name, else from domain: "Acme.com Orders" -> "Acme". */
function merchant_(s) {
  const root = rootOf_(s.domain);
  if (PROCESSORS.has(root)) return '';
  const cap = x => x.replace(/\b[a-z]/g, c => c.toUpperCase());
  const n = String(s.name || '')
    .replace(/\(.*?\)|\bvia\b.*|\b(team|support|no-?reply|orders?|service|notifications?|customer|online)\b/gi, '')
    .replace(/\.(com|co\.il|net|biz)\b/gi, '').replace(/[^\w .&-]/g, '').trim();   // non-Latin display names fall back to the domain
  const flat = x => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (n && n.length <= 25 && flat(n).indexOf(flat(root)) === 0) return cap(n);
  return cap(root);
}

/** lowercase leaf-name -> full label path for existing labels ("acme" -> "Shopping/Acme"). */
function knownLabels_() {
  const skip = new Set(['work', 'learning', 'archive', 'files', 'personal', 'general', 'misc', 'other']);
  const map = {};
  (Gmail.Users.Labels.list('me').labels || []).forEach(l => {
    if (l.type !== 'user') return;
    const leaf = l.name.split('/').pop().toLowerCase().trim();
    if (!skip.has(leaf)) map[leaf] = l.name;
  });
  return map;
}

/* ============================ 3. PLAN ============================ */

/** READ-ONLY: lists what applyPlan() would do for ticked rows not yet "Done". */
function previewPlan() { runPlan_(true); }

/** Creates labels + one filter per ticked sender, and labels that sender's existing mail. Resumable. */
function applyPlan() { runPlan_(false); }

function runPlan_(preview) {
  const sh = openSS_().getSheetByName('Senders');
  const plan = sh.getRange(2, 1, sh.getLastRow() - 1, 12).getValues();
  const t0 = Date.now();

  const labelIds = labelIdMap_();
  const existing = Gmail.Users.Settings.Filters.list('me').filter || [];
  const have = new Set(existing.map(f => String((f.criteria || {}).from || '').toLowerCase() + '|' +
                                         (((f.action || {}).addLabelIds) || []).join(',')));

  let pending = 0, made = 0, labeled = 0, errors = 0;
  for (let i = 0; i < plan.length; i++) {
    const [apply, rawEmail, , , , , , , rawLabel, skip, status] = plan[i];
    const email = String(rawEmail || '').trim().toLowerCase();
    const label = String(rawLabel || '').trim();
    if (apply !== true || !email || !label || status === 'Done') continue;
    pending++;
    if (preview) { Logger.log('[PREVIEW] ' + email + ' -> ' + label + (skip ? ' (skip inbox)' : '')); continue; }
    if (Date.now() - t0 > CFG.MAX_RUNTIME_MS) { Logger.log('Time limit reached - run applyPlan() again to continue.'); break; }

    try {
      const id = ensureLabel_(label, labelIds);
      if (!have.has(email + '|' + id)) {
        Gmail.Users.Settings.Filters.create({
          criteria: { from: email },
          action: { addLabelIds: [id], removeLabelIds: skip ? ['INBOX'] : [] }
        }, 'me');
        have.add(email + '|' + id); made++;
      }
      const ids = messageIdsFrom_(email);
      for (let j = 0; j < ids.length; j += 1000) {
        Gmail.Users.Messages.batchModify({
          ids: ids.slice(j, j + 1000), addLabelIds: [id],
          removeLabelIds: (skip && CFG.ARCHIVE_EXISTING) ? ['INBOX'] : []
        }, 'me');
      }
      labeled += ids.length;
      sh.getRange(i + 2, 11).setValue('Done');
      Logger.log(email + ' -> ' + label + ': ' + ids.length + ' msgs');
    } catch (e) {
      errors++;
      sh.getRange(i + 2, 11).setValue('ERROR: ' + String(e.message).slice(0, 200));
      Logger.log('ERROR ' + email + ': ' + e.message);
    }
  }
  Logger.log(preview
    ? '[PREVIEW] Pending senders: ' + pending + '. Nothing was changed.'
    : 'Filters created: ' + made + ', messages labeled: ' + labeled + ', errors: ' + errors);
}
