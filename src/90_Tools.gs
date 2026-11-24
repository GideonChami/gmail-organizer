/**
 * TOOLS: read-only checks, label maintenance, shared helpers.
 *
 *   checkLabels()                READ-ONLY  plan labels: exist / new / case conflicts
 *   listTriggers()               READ-ONLY  what runs automatically
 *   quickCounts()                READ-ONLY  totals per label
 *   previewMigrateLabels()  / migrateLabels()
 *   previewDeleteEmptyLabels() / deleteEmptyLabels()
 */

/* ============================ read-only checks ============================ */

function checkLabels() {
  const plan = openSS_().getSheetByName('Senders').getDataRange().getValues().slice(1);
  const wanted = new Set();
  plan.forEach(r => { if (r[0] === true && r[8]) wanted.add(String(r[8]).trim()); });

  const all = Gmail.Users.Labels.list('me').labels || [];
  const byName = {};
  all.forEach(l => { byName[l.name.toLowerCase()] = l; });

  Logger.log('--- Labels the plan uses (' + wanted.size + ') ---');
  Array.from(wanted).sort().forEach(name => {
    const l = byName[name.toLowerCase()];
    if (!l) { Logger.log('NEW     ' + name); return; }
    const d = Gmail.Users.Labels.get('me', l.id);
    Logger.log('EXISTS  ' + name + ' [' + l.type + '] ' + (d.messagesTotal || 0) + ' msgs' +
               (l.name !== name ? '  <-- CASE DIFFERS: existing is "' + l.name + '"' : ''));
  });
}

function listTriggers() {
  const t = ScriptApp.getProjectTriggers();
  Logger.log(t.length + ' trigger(s):');
  t.forEach(x => Logger.log('  ' + x.getHandlerFunction() + ' | ' + x.getEventType() + ' | ' + x.getTriggerSource()));
}

function quickCounts() {
  const prof = Gmail.Users.getProfile('me');
  Logger.log('Account: ' + prof.emailAddress + ' | messages: ' + prof.messagesTotal + ' | threads: ' + prof.threadsTotal);
  (Gmail.Users.Labels.list('me').labels || [])
    .map(l => Gmail.Users.Labels.get('me', l.id))
    .sort((a, b) => (b.messagesTotal || 0) - (a.messagesTotal || 0))
    .forEach(d => Logger.log(d.name + ' [' + d.type + ']: ' + (d.messagesTotal || 0) + ' msgs, ' + (d.messagesUnread || 0) + ' unread'));
}

/* ============================ label maintenance ============================ */

function previewMigrateLabels() { migrateLabels_(true); }
function migrateLabels()        { migrateLabels_(false); }

/** Renames labels per LABEL_RENAMES. Messages and filters stay attached (same label ID). */
function migrateLabels_(preview) {
  const cache = labelIdMap_();
  Object.keys(LABEL_RENAMES).forEach(oldName => {
    const newName = LABEL_RENAMES[oldName];
    if (!cache[oldName]) return;
    if (cache[newName]) { Logger.log('SKIP (target exists): ' + oldName + ' -> ' + newName); return; }
    if (preview) { Logger.log('[PREVIEW] rename ' + oldName + ' -> ' + newName); return; }
    const parent = newName.split('/').slice(0, -1).join('/');
    if (parent) ensureLabel_(parent, cache);
    Gmail.Users.Labels.patch({ name: newName }, 'me', cache[oldName]);
    cache[newName] = cache[oldName]; delete cache[oldName];
    Logger.log('Renamed ' + oldName + ' -> ' + newName);
  });
}

function previewDeleteEmptyLabels() { deleteEmptyLabels_(true); }
function deleteEmptyLabels()        { deleteEmptyLabels_(false); }

/** Deletes labels you created that have 0 messages and no children. Mail is never touched. */
function deleteEmptyLabels_(preview) {
  for (let pass = 0; pass < 4; pass++) {
    const labels = (Gmail.Users.Labels.list('me').labels || []).filter(l => l.type === 'user');
    const names = labels.map(l => l.name);
    let removed = 0;
    labels.forEach(l => {
      if (names.some(n => n.indexOf(l.name + '/') === 0)) return;   // has children
      if ((Gmail.Users.Labels.get('me', l.id).messagesTotal || 0) > 0) return;
      if (preview) { Logger.log('[PREVIEW] delete empty label: ' + l.name); return; }
      Gmail.Users.Labels.remove('me', l.id); removed++;
      Logger.log('Deleted empty label: ' + l.name);
    });
    if (preview || !removed) break;
  }
}

/* ============================ shared helpers ============================ */

function openSS_() {
  return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty(CFG.P.SS));
}

/** label name -> label ID, for every label. */
function labelIdMap_() {
  const map = {};
  (Gmail.Users.Labels.list('me').labels || []).forEach(l => { map[l.name] = l.id; });
  return map;
}

/** Returns the label's ID, creating it (and any missing parents) if needed. */
function ensureLabel_(name, cache) {
  if (cache[name]) return cache[name];
  let path = '';
  name.split('/').forEach(part => {
    path = path ? path + '/' + part : part;
    if (!cache[path]) {
      cache[path] = Gmail.Users.Labels.create({
        name: path, labelListVisibility: 'labelShow', messageListVisibility: 'show'
      }, 'me').id;
    }
  });
  return cache[name];
}

/** All message IDs for a list query (excludes spam/trash). maxPages limits the pages read. */
function messageIds_(opts, maxPages) {
  const ids = [];
  let token, pages = 0;
  do {
    const res = Gmail.Users.Messages.list('me',
      Object.assign({ maxResults: 500, fields: 'messages/id,nextPageToken' }, opts, { pageToken: token }));
    ((res && res.messages) || []).forEach(m => ids.push(m.id));
    token = res ? res.nextPageToken : undefined;
    pages++;
  } while (token && (!maxPages || pages < maxPages));
  return ids;
}

/** Current message IDs from an address or a domain. */
function messageIdsFrom_(who) {
  return messageIds_({ q: 'from:"' + who + '"' });
}

/** "mail.shop.example" style subdomains -> registrable domain: "news.acme.com" -> "acme.com", "mail.acme.co.uk" -> "acme.co.uk". */
function regDomain_(domain) {
  const p = String(domain || '').toLowerCase().split('.').filter(Boolean);
  if (p.length <= 2) return p.join('.');
  const tld = p[p.length - 1], sld = p[p.length - 2];
  const ccSecondLevel = tld.length === 2 && ['co', 'org', 'gov', 'ac', 'net', 'com', 'muni', 'k12'].indexOf(sld) >= 0;
  return p.slice(ccSecondLevel ? -3 : -2).join('.');
}

function schedule_(fn, ms) {
  deleteTriggers_(fn);
  ScriptApp.newTrigger(fn).timeBased().after(ms).create();
}

function deleteTriggers_(fn) {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t); });
}
