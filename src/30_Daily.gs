/**
 * DAILY JOB (~04:00): retention + inbox archive (when INBOX_ARCHIVE.ENABLED).
 * Every run writes one row to the "Log" sheet so you can see it is working.
 *
 *   previewRetention()     READ-ONLY  what retention would trash now
 *   previewInboxArchive()  READ-ONLY  what the inbox archive would archive now, broken down by label
 *   archiveInbox()         LIVE       one-off archive of the backlog (ignores ENABLED)
 *   installDailyTrigger()             (re)installs the 04:00 trigger for dailyMaintenance()
 */

function dailyMaintenance() {
  const deadline = Date.now() + CFG.MAX_RUNTIME_MS;
  const trashed = retention_(false, deadline);
  const archived = INBOX_ARCHIVE.ENABLED ? inboxArchive_(false, deadline) : 'off';
  log_('daily', 'newsletters trashed: ' + trashed + ' | inbox archived: ' + archived);
}

function previewRetention()    { retention_(true, Date.now() + CFG.MAX_RUNTIME_MS); }
function previewInboxArchive() { inboxArchive_(true, Date.now() + CFG.MAX_RUNTIME_MS); }

function archiveInbox() {
  const n = inboxArchive_(false, Date.now() + CFG.MAX_RUNTIME_MS);
  log_('archiveInbox (manual)', 'inbox archived: ' + n);
}

function installDailyTrigger() {
  deleteTriggers_('dailyMaintenance');
  ScriptApp.newTrigger('dailyMaintenance').timeBased().everyDays(1).atHour(4).create();
  Logger.log('Installed: dailyMaintenance every day ~04:00 (script time zone). Run listTriggers() to confirm.');
}

/* ---------------------------- retention ---------------------------- */

function retention_(preview, deadline) {
  const id = labelIdMap_()[RETENTION.LABEL];
  if (!id) { Logger.log('Label not found: ' + RETENTION.LABEL); return 0; }
  const opts = { labelIds: [id], q: 'older_than:' + RETENTION.DAYS + 'd -is:starred' };
  if (preview) {
    const ids = messageIds_(opts);
    Logger.log('[PREVIEW] Retention would move ' + ids.length + ' "' + RETENTION.LABEL + '" messages to Trash ' +
               '(older than ' + RETENTION.DAYS + 'd, not starred). Nothing was changed.');
    logSamples_(ids, 10);
    return ids.length;
  }
  return drain_(opts, deadline, ids => trashIds_(ids), 'Retention');
}

/* ---------------------------- inbox archive ---------------------------- */

/**
 * Messages that qualify: in the inbox, older than INBOX_ARCHIVE.DAYS, not starred, and carrying at least one
 * label you created that is NOT in INBOX_ARCHIVE.IGNORE_LABELS (an ignored catch-all label alone does not count).
 * Returns { ids, kept } where kept = messages left in the inbox because they only carry ignored labels.
 */
function inboxArchiveIds_() {
  const age = 'older_than:' + INBOX_ARCHIVE.DAYS + 'd -is:starred';
  const ids = messageIds_({ labelIds: ['INBOX'], q: 'has:userlabels ' + age });
  const userLabels = (Gmail.Users.Labels.list('me').labels || []).filter(l => l.type === 'user');
  const ignoreNames = new Set((INBOX_ARCHIVE.IGNORE_LABELS || []).map(n => n.toLowerCase()));
  const ignoreIds = userLabels.filter(l => ignoreNames.has(l.name.toLowerCase())).map(l => l.id);
  if (!ignoreIds.length) return { ids: ids, kept: 0 };

  const real = new Set(userLabels.filter(l => ignoreIds.indexOf(l.id) < 0).map(l => l.id));
  const suspects = new Set();
  ignoreIds.forEach(id => messageIds_({ labelIds: ['INBOX', id], q: age }).forEach(x => suspects.add(x)));
  const keep = new Set();
  suspects.forEach(x => {
    const m = Gmail.Users.Messages.get('me', x, { format: 'minimal', fields: 'labelIds' });
    if (!(m.labelIds || []).some(l => real.has(l))) keep.add(x);
  });
  return { ids: ids.filter(x => !keep.has(x)), kept: keep.size };
}

function inboxArchive_(preview, deadline) {
  const r = inboxArchiveIds_();
  const ids = r.ids;
  if (preview) {
    Logger.log('[PREVIEW] Inbox archive would archive ' + ids.length + ' messages (labeled, older than ' +
               INBOX_ARCHIVE.DAYS + 'd, not starred). They stay under their labels and in All Mail. Nothing was changed.');
    Logger.log('Kept in inbox because their only label is one of ' + JSON.stringify(INBOX_ARCHIVE.IGNORE_LABELS || []) + ': ' + r.kept);
    Logger.log('--- by label (a message with two labels counts twice) ---');
    const ignore = new Set((INBOX_ARCHIVE.IGNORE_LABELS || []).map(n => n.toLowerCase()));
    const rows = [];
    (Gmail.Users.Labels.list('me').labels || [])
      .filter(l => l.type === 'user' && !ignore.has(l.name.toLowerCase()))
      .forEach(l => {
        const n = messageIds_({ labelIds: ['INBOX', l.id], q: 'older_than:' + INBOX_ARCHIVE.DAYS + 'd -is:starred' }).length;
        if (n) rows.push([l.name, n]);
      });
    rows.sort((a, b) => b[1] - a[1]).forEach(x => Logger.log('  ' + x[1] + '  ' + x[0]));
    logSamples_(ids, 10);
    return ids.length;
  }
  let done = 0;
  for (let i = 0; i < ids.length; i += 500) {
    if (Date.now() > deadline) { Logger.log('Inbox archive: time limit reached after ' + done + ' messages - run again to continue.'); return done; }
    const chunk = ids.slice(i, i + 500);
    Gmail.Users.Messages.batchModify({ ids: chunk, removeLabelIds: ['INBOX'] }, 'me');
    done += chunk.length;
  }
  Logger.log('Inbox archive: complete, ' + done + ' messages this run.');
  return done;
}

/* ---------------------------- shared ---------------------------- */

/** Takes the first page of a query, applies fn, repeats until the query is empty or time runs out. */
function drain_(opts, deadline, fn, name) {
  let total = 0, lastFirst = '';
  while (Date.now() < deadline) {
    const res = Gmail.Users.Messages.list('me', Object.assign({ maxResults: 500, fields: 'messages/id' }, opts));
    const ids = ((res && res.messages) || []).map(m => m.id);
    if (!ids.length) { Logger.log(name + ': complete, ' + total + ' messages this run.'); return total; }
    if (ids[0] === lastFirst) { Logger.log(name + ': STOP - messages are not leaving the query. Nothing more done.'); return total; }
    lastFirst = ids[0];
    fn(ids);
    total += ids.length;
  }
  Logger.log(name + ': time limit reached after ' + total + ' messages - run again to continue.');
  return total;
}

function trashIds_(ids) {
  try {
    Gmail.Users.Messages.batchModify({ ids: ids, addLabelIds: ['TRASH'] }, 'me');
  } catch (e) {
    Logger.log('Bulk trash refused (' + e.message + ') - trashing one by one.');
    ids.forEach(id => Gmail.Users.Messages.trash('me', id));
  }
}

function logSamples_(ids, n) {
  ids.slice(0, n).forEach(id => {
    const m = Gmail.Users.Messages.get('me', id, { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
    const h = {}; ((m.payload && m.payload.headers) || []).forEach(x => { h[x.name] = x.value; });
    Logger.log('  sample: ' + h['Date'] + ' | ' + h['From'] + ' | ' + h['Subject']);
  });
}

/** Appends one row to the "Log" sheet. */
function log_(job, result) {
  const ss = openSS_();
  const sh = ss.getSheetByName('Log') || ss.insertSheet('Log');
  if (sh.getLastRow() === 0) sh.appendRow(['When', 'Job', 'Result']);
  sh.appendRow([new Date(), job, result]);
  Logger.log(job + ': ' + result);
}
