// ============================================================
// Man Camp Registration System
// Google Apps Script — Utilities.gs
// Shared helper functions used across all modules.
//
// KEY DESIGN: Dynamic column mapping functions eliminate all
// hardcoded array indices (e.g. values[30]) when reading sheet
// data. If columns are ever reordered or new columns are added,
// these helpers automatically adapt.
// ============================================================


// ============================================================
// DYNAMIC COLUMN MAPPING
// ============================================================

/**
 * Builds a map of { lowerCaseHeaderName: 0-basedArrayIndex } from
 * a sheet's first row. Use this when you already have the sheet's
 * data loaded into a 2-D array and need to access columns by name.
 *
 * Example:
 *   const colMap = getColumnMap_(regSheet);
 *   const clubName = row[colMap['club_name']];
 *
 * @param  {Sheet} sheet — any Google Apps Script Sheet object
 * @returns {Object}     map of header → 0-based index
 */
function getColumnMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h, i) => {
    const key = String(h).trim().toLowerCase();
    if (key) map[key] = i;
  });
  return map;
}

/**
 * Same as getColumnMap_ but strips all non-alphanumeric characters from header
 * keys (e.g. 'registration_id' → 'registrationid'). Use this when reading sheets
 * whose column-lookup code uses stripped keys (no underscores/spaces).
 *
 * @param  {Sheet} sheet — any Google Apps Script Sheet object
 * @returns {Object}     map of strippedHeader → 0-based index
 */
function getStrippedColumnMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h, i) => {
    const key = String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (key) map[key] = i;
  });
  return map;
}

/**
 * Returns the 1-based column number for a named header in a sheet.
 * Use this when calling sheet.getRange(row, col, ...) and you want
 * to look up the column number by header name rather than hardcoding it.
 *
 * Returns -1 if the header is not found (caller should guard against this).
 *
 * Example:
 *   const col = getColumnNumber_(regSheet, 'fluent_form_entry_id');
 *   if (col > 0) {
 *     const values = regSheet.getRange(2, col, lastRow - 1, 1).getValues();
 *   }
 *
 * @param  {Sheet}  sheet      — any Google Apps Script Sheet object
 * @param  {string} headerName — exact header text (case-insensitive)
 * @returns {number}           1-based column number, or -1 if not found
 */
function getColumnNumber_(sheet, headerName) {
  const map = getColumnMap_(sheet);
  const idx = map[String(headerName).trim().toLowerCase()];
  return idx !== undefined ? idx + 1 : -1;
}

/**
 * Reads a single sheet row and returns a plain object keyed by
 * lower-case header names. This completely eliminates hardcoded
 * array indices when reading individual rows.
 *
 * Example:
 *   const row = readRowAsObject_(regSheet, 5);
 *   const email = row['registrant_email'];  // no index needed
 *
 * @param  {Sheet}  sheet  — any Google Apps Script Sheet object
 * @param  {number} rowNum — 1-based row number to read
 * @returns {Object}       { headerName: cellValue, ... }
 */
function readRowAsObject_(sheet, rowNum) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const values  = sheet.getRange(rowNum, 1, 1, lastCol).getValues()[0];
  const obj = {};
  headers.forEach((h, i) => {
    const key = String(h).trim().toLowerCase();
    if (key) obj[key] = values[i];
  });
  return obj;
}

/**
 * Appends a row to a sheet by matching object keys to header names.
 * Missing keys write as blank strings. Extra keys are ignored.
 *
 * @param {Sheet}  sheet
 * @param {Object} rowObj
 */
function appendRowFromObject_(sheet, rowObj) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const values = headers.map(header => {
    const key = String(header).trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(rowObj, key) ? rowObj[key] : '';
  });
  sheet.appendRow(values);
}

/**
 * Updates an existing row by matching object keys to header names.
 *
 * @param {Sheet}  sheet
 * @param {number} rowNum
 * @param {Object} rowObj
 */
function updateRowFromObject_(sheet, rowNum, rowObj) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  headers.forEach((header, idx) => {
    const key = String(header).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(rowObj, key)) {
      sheet.getRange(rowNum, idx + 1).setValue(rowObj[key]);
    }
  });
}


// ============================================================
// ID GENERATION
// ============================================================

/**
 * Generates a unique registration ID, verifying it does not already
 * exist in the Registrations sheet.  Retries up to 5 times before
 * throwing, keeping collision probability effectively zero.
 *
 * Format: REG-{YEAR}-{3-DIGIT-RANDOM}{3-LETTER-RANDOM}
 * Example: REG-2026-543ABC
 *
 * @param  {Sheet} regSheet — Registrations sheet (used for duplicate check)
 * @returns {string}
 */
function generateRegistrationId_(regSheet) {
  const year = new Date().getFullYear();

  // Hold a script-level lock so that two concurrent doPost() calls cannot both
  // read the same existing-ID list, generate the same new ID, and both pass the
  // uniqueness check before either has written its row to the sheet.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);  // wait up to 30 s — throws if lock is unavailable

  try {
    const colNum  = getColumnNumber_(regSheet, 'registration_id');
    const lastRow = regSheet.getLastRow();
    const existingIds = (colNum > 0 && lastRow > 1)
      ? regSheet.getRange(2, colNum, lastRow - 1, 1).getValues().flat().map(String)
      : [];

    for (let attempt = 0; attempt < 5; attempt++) {
      const random = Math.floor(Math.random() * 900 + 100);
      const suffix = Math.random().toString(36).substring(2, 5).toUpperCase();
      const id     = `REG-${year}-${random}${suffix}`;
      if (!existingIds.includes(id)) return id;
      Logger.log('generateRegistrationId_: collision on attempt ' + (attempt + 1) + ' for ' + id + ' — retrying.');
    }
    throw new Error('generateRegistrationId_: could not generate a unique ID after 5 attempts.');
  } finally {
    lock.releaseLock();
  }
}


// ============================================================
// STRING / HTML UTILITIES
// ============================================================

/**
 * Escapes HTML special characters to prevent XSS in email HTML.
 *
 * @param  {*}      str — value to escape (coerced to string)
 * @returns {string}
 */
function escapeHtml_(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Normalizes an array or JSON-array field to a readable comma-separated string.
 * Handles: undefined/null, raw arrays, JSON strings encoding arrays, plain strings.
 *
 * @param  {*}      value
 * @returns {string}
 */
function normalizeArrayField_(value) {
  if (!value) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.join(', ');
    } catch (e) { /* not JSON */ }
    return value;
  }
  return String(value);
}


// ============================================================
// FORMATTING UTILITIES
// ============================================================

/**
 * Maps gender strings to short display labels.
 *
 * @param  {string} gender
 * @returns {string}  'M', 'F', or '—'
 */
function formatGender_(gender) {
  if (!gender) return '—';
  const map = { male: 'M', female: 'F', 'prefer not to say': '—' };
  return map[gender.toLowerCase()] || gender;
}

/**
 * Formats a number as USD currency string.
 * Example: 1234.5 → '$1,234.50'
 *
 * @param  {number} amount
 * @returns {string}
 */
function formatCurrency_(amount) {
  return '$' + Number(amount).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
