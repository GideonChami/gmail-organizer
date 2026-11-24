/**
 * GMAIL ORGANIZER - CONFIGURATION (no logic in this file)
 *
 * Edit this file to fit your mailbox. Everything else reads from here.
 *
 * Every action that changes Gmail has a matching preview that changes nothing:
 *
 *   Refresh senders : startScan() -> analyze() -> review "Senders" sheet -> previewPlan() -> applyPlan()
 *   Domain filters  : previewDomainFilters() -> applyDomainFilters()
 *   Inbox archive   : previewInboxArchive()  -> archiveInbox()
 *   Retention       : previewRetention()        (the live part runs in the daily job)
 *   Daily job       : dailyMaintenance() ~04:00, installed by installDailyTrigger()
 *   Read-only checks: checkLabels(), listTriggers(), quickCounts()
 *
 * What can remove mail: ONLY messages labeled RETENTION.LABEL older than RETENTION.DAYS -> Trash
 * (Gmail empties Trash after 30 days). Starred mail is never trashed and never archived.
 */

const CFG = {
  SPREADSHEET_NAME: 'Gmail Organizer',      // created by the first startScan()
  QUERY: 'in:anywhere -in:spam -in:trash',  // what startScan() reads
  SAMPLE_LIMIT: 0,                          // 0 = scan everything; e.g. 20000 = newest 20k messages only
  PARALLEL: 10,                             // parallel metadata requests during the scan
  MAX_RUNTIME_MS: 3 * 60 * 1000,            // every job stops itself well before the 6-minute Apps Script limit
  MIN_COUNT: 5,                             // senders with fewer messages are not auto-ticked in "Senders"
  MAX_FILTERS: 900,                         // Gmail hard limit is 1000 filters
  ARCHIVE_EXISTING: false,                  // applyPlan(): also archive existing mail of "Skip inbox" senders
  P: { SS: 'GO_SS_ID', TOKEN: 'GO_TOKEN', COUNT: 'GO_COUNT', STATUS: 'GO_STATUS', DOMAINS: 'GO_DOMAINS_DONE' }
};

/** Retention: mail with this label older than DAYS is moved to Trash by the daily job. */
const RETENTION = {
  LABEL: 'Newsletters',
  DAYS: 60
};

/** Inbox archive: labeled mail older than DAYS leaves the inbox. It stays under its label and in All Mail. */
const INBOX_ARCHIVE = {
  ENABLED: false,   // set to true only AFTER previewInboxArchive() looks right; the daily job then archives too
  DAYS: 60,
  IGNORE_LABELS: [] // labels that do not count as "labeled", e.g. a catch-all label such as 'Has Files'
};

/* ---------------------------- label names ---------------------------- */
/*
 * NOTE: Gmail reserves some names for its own inbox tabs. You cannot create labels called
 * "Social", "Promotions", "Updates" or "Forums" (and possibly "Purchases"). Use different names (as below).
 */

/** Gmail category -> label, used when no rule matched. */
const CATEGORY_FALLBACK = {
  CATEGORY_PROMOTIONS: 'Newsletters',
  CATEGORY_SOCIAL: 'Social Media',
  CATEGORY_UPDATES: 'Notifications',
  CATEGORY_FORUMS: 'Mailing Lists'
};

/** Senders whose label is one of these get "Skip inbox" ticked by default. */
const SKIP_INBOX_LABELS = ['Newsletters', 'Social Media', 'Mailing Lists'];

/* ---------------------------- classification rules (used by analyze) ---------------------------- */

/**
 * Matched against sender address + display name + recent subjects. First match wins.
 * merchant:true = add a child label named after the sender ("Shopping/Acme").
 * commerce:true = a mostly-marketing sender (>60% of messages have an unsubscribe header) skips this rule.
 * Add rules in your own language too - regexes accept any script.
 */
const RULES = [
  { label: 'Finance',   re: /\bbank\b|credit ?card|statement|brokerage|investment|\btax(es)?\b/ },
  { label: 'Insurance', re: /insurance|\bpolicy\b|\bclaim\b/ },
  { label: 'Work',      re: /jira|github|gitlab|atlassian|confluence|slack|zoom|payslip|timesheet/ },
  { label: 'Learning',  re: /coursera|udemy|pluralsight|edx|webinar|certification|\bcourse\b/ },
  { label: 'Travel',    merchant: true, commerce: true,
                        re: /booking\.com|airbnb|expedia|hotel|reservation|boarding pass|itinerary|airline|check-in/ },
  { label: 'Shopping',  merchant: true, commerce: true,
                        re: /\border\b|receipt|invoice|payment|shipping|shipped|delivery|tracking|your purchase/ }
];

/**
 * Sender-address rules, checked BEFORE everything else.
 * [regex on the sender address, label, applyEvenIfMarketing]
 * Examples (uncomment and adapt):
 *   [/@mybank\.example$/,              'Finance/My Bank', true],
 *   [/@(mail\.)?shop\.example$/,       'Shopping/Shop',   false],
 *   [/linkedin|facebook|instagram/,    'Social Media',    true],
 */
const SENDER_RULES = [
  [/linkedin|facebook|instagram|pinterest|tiktok|twitter|@x\.com$/, 'Social Media', true]
];

/** Never auto-hide these senders from the inbox, even if they look like marketing (security, money, parcels). */
const NEVER_SKIP = /security|^login@|verif|password|2fa|\botp\b|bank|parcel|tracking|delivery/i;

/** Personal mailbox providers: never auto-labeled, never get a domain filter. */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com'
]);

/** Payment processors: a child label named after them would be meaningless, so none is added. */
const PROCESSORS = new Set(['paypal', 'stripe', 'squareup', 'paddle', 'fastspring']);

/* ---------------------------- domain filters ---------------------------- */

/**
 * Never create a whole-domain filter for these. Shared sending platforms carry mail for many
 * unrelated companies. Add any domain here to keep it on per-address filters only.
 */
const DOMAIN_EXCLUDE = new Set([
  'shopifyemail.com', 'mailchimpapp.com', 'mcsv.net', 'sendgrid.net', 'amazonses.com', 'mailgun.org',
  'sparkpostmail.com', 'hubspotemail.net', 'klaviyomail.com', 'exacttarget.com', 'docusign.net',
  'zendesk.com', 'myworkday.com', 'greenhouse-mail.io', 'substack.com', 'googlegroups.com'
]);

/** Government domains are never extended to a whole-domain filter (many unrelated offices share them). */
const GOVERNMENT_DOMAINS = /(^|\.)(gov|mil)(\.[a-z]{2})?$/;

/* ---------------------------- optional: one-time label renames ---------------------------- */

/** Used by previewMigrateLabels() / migrateLabels(). Example: { 'Old Name': 'Finance/Old Name' } */
const LABEL_RENAMES = {};
