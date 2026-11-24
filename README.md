# Gmail Organizer

A Google Apps Script that audits your whole Gmail mailbox, proposes a label for every sender, and — after you review the plan in a Google Sheet — creates the labels and filters for you. A daily job then keeps things tidy: old newsletters go to Trash and old labeled mail leaves the inbox.

Runs entirely inside your own Google account. No external servers, no third-party access.

## What it does

| Stage | Function | Changes Gmail? |
|---|---|---|
| Scan every message's sender, subject and Gmail category into a sheet | `startScan()` | No |
| Group by sender and suggest a label + "skip inbox" per sender | `analyze()` | No |
| You review and edit the `Senders` sheet | — | No |
| Create labels, one filter per sender, label existing mail | `previewPlan()` → `applyPlan()` | Yes |
| One filter per brand domain, so low-volume and new addresses are caught too | `previewDomainFilters()` → `applyDomainFilters()` | Yes |
| Archive labeled mail older than N days out of the inbox | `previewInboxArchive()` → `archiveInbox()` | Yes |
| Daily at ~04:00: retention + inbox archive, one row per run in a `Log` sheet | `installDailyTrigger()` | Yes |

## Safety model

- **Every action that changes Gmail has a preview function** that logs exactly what would happen and changes nothing. Run the preview first, every time.
- **The only thing that ever removes mail** is retention: messages carrying the retention label (default `Newsletters`) older than N days (default 60) are moved to **Trash**, where Gmail keeps them for 30 more days.
- **Starred mail is never trashed and never archived.** Star anything you want to keep in view.
- **Mail from personal addresses** (gmail.com, outlook.com, …) is never auto-labeled, so it stays in the inbox.
- **Inbox archiving only removes the inbox flag.** Archived mail stays under its label and in All Mail.
- **Domain filters only add a label.** They never skip the inbox, never cover shared sending platforms, government domains or the retention label, and never cover a domain whose senders you labeled differently.
- All long jobs stop themselves before Apps Script's 6-minute limit and are **resumable**: run them again and they continue where they left off.

## Setup

1. Go to [script.google.com](https://script.google.com) → **New project**. Name it, e.g. `Gmail Organizer`.
2. **Project Settings** (gear icon):
   - Tick **Show "appsscript.json" manifest file in editor**.
   - Set **Time zone** to yours (the daily job runs at ~04:00 in this zone).
3. Back in the editor, replace the contents of `appsscript.json` with [`src/appsscript.json`](src/appsscript.json). Keep your own `timeZone` value.
4. Create one script file per file in [`src/`](src/) (`+` → **Script**, use the same names without `.gs`) and paste each file's content. Delete the default `Code.gs`, or rename it to `00_Config` and replace its content.
5. **Services** → `+` → **Gmail API** → Add (identifier `Gmail`). The manifest already declares it; this just confirms it is on.
6. Edit [`00_Config.gs`](src/00_Config.gs) to fit your mailbox (see below).

The first run of any function asks you to authorize the script. The scopes are listed in the manifest: read/modify mail and labels, manage filters, create the spreadsheet, make parallel API calls during the scan, and manage its own triggers.

> **Tip:** the function dropdown in the editor lists the functions of the file that is currently open. Always check which function is selected before clicking **Run**.

## Workflow

### 1. Scan and analyze (read-only)

1. Run `startScan()`. It creates a spreadsheet (link in the log) and reads metadata of all messages into the `Raw` sheet. Large mailboxes take several runs; it schedules itself to continue automatically.
2. Run `analyze()`. It builds the `Senders` sheet: one row per sender with message count, unsubscribe ratio, Gmail category, **Suggested label**, **Skip inbox**, and a sample subject.

### 2. Review the `Senders` sheet

- **Apply** (column A): tick to create a filter for this sender. Senders with at least `MIN_COUNT` messages and a non-`Review` label are ticked by default.
- **Suggested label** (column I): edit freely. Use `/` for nesting, e.g. `Shopping/Acme`.
- **Skip inbox** (column J): new mail from this sender goes straight to its label.
- Re-running `analyze()` later **keeps your edits** for known senders; new senders get today's date in **Added**.

> Avoid sheet-wide Find & Replace: a partial match will also change sender addresses in column B. If you must, select column I only and tick **Match entire cell contents**.

### 3. Pre-flight checks (read-only)

- `checkLabels()` — lists every label the plan uses: `EXISTS` / `NEW`, and warns when a name differs from an existing label only by case (that would make label creation fail).
- Gmail reserves `Social`, `Promotions`, `Updates` and `Forums` (and possibly `Purchases`). If unsure about a name, try creating it by hand in Gmail first.

### 4. Apply

1. `previewPlan()` → read the log.
2. `applyPlan()` → creates labels + filters and labels existing mail. Each finished sender is marked `Done` in the sheet; errors are written into the **Status** column and the run continues. Re-run until no `Time limit reached` line appears.

### 5. Domain filters (optional, recommended)

`previewDomainFilters()` → `applyDomainFilters()`. Replaces many per-address filters with one filter per brand domain, catching low-volume senders and any new address the brand starts using. Redundant per-address filters are removed only after a search confirms the domain filter matches that sender's mail.

### 6. Inbox archive + daily job

1. `previewRetention()` — what retention would trash now.
2. `previewInboxArchive()` — what would leave the inbox, broken down by label, with samples.
3. `archiveInbox()` — one-off archive of the backlog.
4. Set `INBOX_ARCHIVE.ENABLED: true` in `00_Config.gs`.
5. `installDailyTrigger()` then `listTriggers()` to confirm one `dailyMaintenance` trigger.

Optional: with filters doing the sorting, you can turn off Gmail's inbox tabs (Settings → Inbox → Categories → untick all but Primary).

## Configuration

Everything lives in [`src/00_Config.gs`](src/00_Config.gs):

| Setting | Purpose |
|---|---|
| `RULES` | Keyword rules on sender + name + subjects. First match wins. `merchant: true` adds a child label per merchant; `commerce: true` skips mostly-marketing senders. Write rules in any language. |
| `SENDER_RULES` | Regex rules on the sender address, checked first. Use them for your bank, employer, clubs, etc. |
| `CATEGORY_FALLBACK` | Label to use from Gmail's own category when nothing else matched. |
| `SKIP_INBOX_LABELS` | Labels whose senders get "Skip inbox" ticked by default. |
| `NEVER_SKIP` | Sender patterns that are never hidden from the inbox (security codes, parcels, money). |
| `FREE_MAIL` | Personal mailbox domains: never auto-labeled. |
| `RETENTION` | Label and age for auto-trash. |
| `INBOX_ARCHIVE` | Age, on/off, and labels that don't count as "labeled". |
| `DOMAIN_EXCLUDE`, `GOVERNMENT_DOMAINS` | Domains that never get a whole-domain filter. |
| `MIN_COUNT`, `MAX_RUNTIME_MS`, `PARALLEL` | Thresholds and performance. |

## Keeping it up to date

Every few months: `startScan()` → `analyze()` → filter the `Senders` sheet by **Added** = today → review → `previewPlan()` → `applyPlan()` → `previewDomainFilters()` → `applyDomainFilters()`.

## Undo / recovery

- **Trashed mail**: Gmail → Trash. Labels are kept for the 30 days it stays there; select and **Move to Inbox**.
- **Archived mail**: still under its label and in All Mail; search `label:your-label older_than:60d`, select, **Move to Inbox**.
- **Filters**: Gmail → Settings → Filters and Blocked Addresses.
- **Stop the daily job**: Apps Script → Triggers (clock icon) → delete `dailyMaintenance`.

## Limits

- Gmail allows 1,000 filters per account (`MAX_FILTERS` keeps a margin).
- Apps Script runs are capped at 6 minutes; jobs stop at `MAX_RUNTIME_MS` and resume on the next run.
- Gmail filters apply to new mail only; the script labels existing mail separately.

## Optional: deploy with clasp

```bash
npm install -g @google/clasp
clasp login
cp .clasp.json.example .clasp.json   # put your scriptId in it
clasp push
```

## License

MIT — see [LICENSE](LICENSE).
