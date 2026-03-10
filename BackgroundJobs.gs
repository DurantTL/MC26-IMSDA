// ============================================================
// Man Camp Registration System
// Google Apps Script — BackgroundJobs.gs
//
// Asynchronous job queue for post-registration work.
//
// PURPOSE
// -------
// doPost() must return a response to Fluent Forms within the
// 6-minute Apps Script execution limit (and ideally much faster
// to avoid WordPress plugin timeouts). Email sending and report
// regeneration are offloaded here so doPost() can acknowledge
// the registration immediately after writing to the database.
//
// HOW IT WORKS
// ------------
// 1. processRegistration() writes data to sheets, then calls
//    enqueueBackgroundJob_() twice — once for the email job
//    and once for the report-rebuild job.
// 2. scheduleBackgroundTrigger_() creates a one-off time-driven
//    trigger (minimum 1 minute delay) to run processBackgroundJobs()
//    unless one is already scheduled.
// 3. processBackgroundJobs() dequeues all pending jobs:
//      - email jobs: reconstruct data from sheets, send Email 1,
//        log to EmailLog sheet.
//      - report jobs: deduplicated — only one report run per
//        batch, regardless of how many clubs just registered.
// 4. LockService prevents concurrent trigger executions from
//    double-processing the same job queue.
//
// PROPERTIES KEYS
// ---------------
// BACKGROUND_JOBS — JSON array of pending job objects:
//   { type: 'email'|'report', registrationId, registrantEmail,
//     clubName, enqueuedAt }
// ============================================================


const JOBS_PROPERTY_KEY = 'BACKGROUND_JOBS';


// ============================================================
// SECTION 1 — PUBLIC API (called from Registration.gs)
// ============================================================

/**
 * Adds a job to the persistent background queue.
 * Uses LockService to prevent race conditions when multiple
 * registrations arrive within the same second.
 *
 * @param {Object} job  Must include { type: 'email'|'report' }.
 *                      Email jobs also need registrationId,
 *                      registrantEmail, clubName.
 */
function enqueueBackgroundJob_(job) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    let queue;
    try {
      queue = JSON.parse(props.getProperty(JOBS_PROPERTY_KEY) || '[]');
    } catch (e) {
      Logger.log('enqueueBackgroundJob_: Queue parse error, resetting: ' + e);
      queue = [];
    }

    // Purge stale jobs older than 10 minutes — GAS triggers fire within ~1 min,
    // so anything stuck longer is unprocessable and should not block new jobs.
    const TEN_MINUTES = 10 * 60 * 1000;
    queue = queue.filter(j => {
      const age = Date.now() - new Date(j.enqueuedAt).getTime();
      if (age > TEN_MINUTES) {
        Logger.log('enqueueBackgroundJob_: purging stale job (age=' + Math.round(age / 1000) + 's): ' + JSON.stringify(j));
        return false;
      }
      return true;
    });

    job.enqueuedAt = new Date().toISOString();
    queue.push(job);

    const serialized = JSON.stringify(queue);
    if (serialized.length > 8000) {
      Logger.log('enqueueBackgroundJob_: WARNING — queue JSON is ' + serialized.length
        + ' bytes, approaching PropertiesService 9 KB limit. Consider processing jobs sooner.');
    }

    try {
      props.setProperty(JOBS_PROPERTY_KEY, serialized);
    } catch (e) {
      Logger.log('enqueueBackgroundJob_: ERROR — could not save queue to Script Properties: ' + e);
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Creates a one-off time-driven trigger for processBackgroundJobs
 * if one is not already scheduled. Safe to call repeatedly.
 */
function scheduleBackgroundTrigger_() {
  const alreadyScheduled = ScriptApp.getProjectTriggers()
    .some(t => t.getHandlerFunction() === 'processBackgroundJobs');
  if (alreadyScheduled) return;

  ScriptApp.newTrigger('processBackgroundJobs')
    .timeBased()
    .after(60 * 1000)   // 1-minute minimum — GAS cannot go lower
    .create();
  Logger.log('scheduleBackgroundTrigger_: Trigger created.');
}


// ============================================================
// SECTION 2 — BACKGROUND PROCESSOR (called by time-driven trigger)
// ============================================================

/**
 * Dequeues and processes all pending background jobs.
 *
 * Job types:
 *   'email'  — send Email 1 (confirmation) for a single registration
 *   'report' — regenerate Club Dashboard + Camping Coordinator sheets
 *              (deduplicated: only one report run per batch)
 *
 * The trigger that fired this function is deleted first so that
 * errors don't leave a ghost trigger behind.
 */
function processBackgroundJobs() {
  // Delete the trigger that invoked this run
  deleteTriggersForFunction_('processBackgroundJobs');

  // Acquire lock to prevent concurrent executions
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('processBackgroundJobs: Could not acquire lock — another execution may be running.');
    return;
  }

  const props = PropertiesService.getScriptProperties();
  let queue;
  try {
    queue = JSON.parse(props.getProperty(JOBS_PROPERTY_KEY) || '[]');
  } catch (e) {
    Logger.log('processBackgroundJobs: Queue parse error: ' + e);
    lock.releaseLock();
    return;
  }

  if (queue.length === 0) {
    Logger.log('processBackgroundJobs: No jobs in queue.');
    lock.releaseLock();
    return;
  }

  // Clear queue immediately (under lock) so a concurrent invocation
  // of scheduleBackgroundTrigger_() won't schedule a redundant run
  props.setProperty(JOBS_PROPERTY_KEY, JSON.stringify([]));
  lock.releaseLock();

  Logger.log('processBackgroundJobs: Processing ' + queue.length + ' job(s).');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let reportNeeded = false;

  for (const job of queue) {
    try {
      if (job.type === 'email') {
        processEmailJob_(ss, job);
      } else if (job.type === 'report') {
        // Collect all report requests; run once at the end
        reportNeeded = true;
      } else {
        Logger.log('processBackgroundJobs: Unknown job type "' + job.type + '" — skipping.');
      }
    } catch (err) {
      Logger.log('processBackgroundJobs: Job failed ('
        + job.type + '/' + (job.registrationId || '') + '): ' + err.toString());
      // Do not re-queue failed jobs to prevent infinite retry loops.
      // Email failures are already recorded in EmailLog by processEmailJob_.
    }
  }

  // Run report generation once for the entire batch
  if (reportNeeded) {
    try {
      generateAllReportSheets();
      Logger.log('processBackgroundJobs: Report sheets rebuilt successfully.');
    } catch (err) {
      Logger.log('processBackgroundJobs: Report rebuild failed: ' + err.toString());
    }
  }

  Logger.log('processBackgroundJobs: All jobs processed. Queue cleared.');
}


// ============================================================
// SECTION 3 — INTERNAL JOB PROCESSORS
// ============================================================

/**
 * Reconstructs a registration's data object from the Registrations
 * sheet and sends Email 1 (confirmation). Logs result to EmailLog.
 *
 * Reading from sheets (rather than embedding the full data in the
 * job payload) keeps the queue well under PropertiesService's 9 KB
 * per-property limit even for registrations with large rosters.
 *
 * @param {Spreadsheet} ss
 * @param {Object}      job  { registrationId, registrantEmail, clubName }
 */
function processEmailJob_(ss, job) {
  if (!CONFIG.email.enabled) {
    Logger.log('processEmailJob_: Email disabled in CONFIG — skipping.');
    return;
  }
  if (!job.registrantEmail) {
    Logger.log('processEmailJob_: No registrantEmail in job for ' + job.registrationId + ' — skipping.');
    return;
  }

  const regSheet = ss.getSheetByName(CONFIG.sheets.registrations);
  if (!regSheet) throw new Error('Registrations sheet not found');

  const rowNum = findRegistrationRow_(regSheet, job.registrationId);
  if (rowNum < 0) throw new Error('Registration ID ' + job.registrationId + ' not found in sheet');

  const data = buildConfirmationEmailDataFromRegistration_(ss, job.registrationId);

  try {
    sendConfirmationEmail_(data);
    logEmail_(ss, job.registrationId, data.registrantEmail, data.registrationLabel, 'email1_sent', '');
    Logger.log('processEmailJob_: Email 1 sent for ' + job.registrationId);
  } catch (emailErr) {
    logEmail_(ss, job.registrationId, data.registrantEmail || job.registrantEmail, data.registrationLabel || job.clubName, 'email1_failed', emailErr.toString());
    throw emailErr;   // Re-throw so outer loop can log it
  }
}


// ============================================================
// SECTION 4 — TRIGGER UTILITIES (shared with generateRegistrationPDF.gs)
// ============================================================

/**
 * Finds the sheet row number (1-based) for a given registration ID.
 * Returns -1 if not found.
 *
 * @param  {Sheet}  sheet          — Registrations sheet
 * @param  {string} registrationId
 * @returns {number}  1-based row index, or -1
 */
function findRegistrationRow_(sheet, registrationId) {
  const colNum = getColumnNumber_(sheet, 'registration_id');
  if (colNum < 0) return -1;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, colNum, lastRow - 1, 1).getValues().flat();
  const idx = ids.indexOf(String(registrationId));
  return idx >= 0 ? idx + 2 : -1;
}

/**
 * Deletes all project triggers whose handler function matches
 * the given name. Used to clean up one-off triggers after they
 * fire, and to cancel in-progress background jobs.
 *
 * @param {string} functionName — exact handler function name
 */
function deleteTriggersForFunction_(functionName) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === functionName)
    .forEach(t => ScriptApp.deleteTrigger(t));
}
