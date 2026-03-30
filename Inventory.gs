// ============================================================
// Man Camp Registration System
// Google Apps Script — Inventory.gs
// Centralized public availability and inventory counting helpers.
// ============================================================

function getAvailability() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lodging = calculateRemainingInventory(ss).byCategory;
  const shirts = calculateRemainingShirtInventory_(ss);
  const options = getRegistrationOptionDefinitions_().map(option => {
    const lodgingStats = lodging[option.inventoryCategory] || {};
    const remaining = option.countsAsUnlimited
      ? 'Unlimited'
      : (typeof lodgingStats.remainingPublicCapacity === 'number' ? lodgingStats.remainingPublicCapacity : option.publicCapacity || 0);
    const soldOut = !option.countsAsUnlimited && Number(remaining) <= 0;
    return {
      optionKey: option.key,
      optionLabel: option.label,
      attendanceType: option.attendanceType,
      lodgingType: option.lodgingType,
      price: option.price,
      available: remaining,
      soldOut: soldOut,
      waitlistAllowed: !!option.waitlistAllowed,
      statusLabel: soldOut && option.waitlistAllowed ? 'Waitlist' : (soldOut ? 'Sold Out' : 'Available')
    };
  });

  return {
    success: true,
    options: options,
    shirts: shirts,
    timestamp: new Date().toISOString()
  };
}

function getRegistrationOptionDefinitions_() {
  const definitions = CONFIG && CONFIG.registrationOptions ? CONFIG.registrationOptions : {};
  return Object.keys(definitions).map(key => {
    const option = CONFIG.registrationOptions[key];
    const lodgingDefinition = resolveLodgingDefinitionForInventory_(option.inventoryCategory);
    return Object.assign({}, option, {
      publicCapacity: lodgingDefinition ? lodgingDefinition.publicCapacity : 0,
      isUnlimited: lodgingDefinition ? lodgingDefinition.isUnlimited : !!option.countsAsUnlimited,
      price: lodgingDefinition && typeof lodgingDefinition.price === 'number'
        ? lodgingDefinition.price
        : (typeof option.price === 'number' ? option.price : 0)
    });
  });
}

function getRegistrationOptionByKey_(optionKey) {
  const normalized = normalizeLodgingPreferenceSafe_(optionKey);
  const match = getRegistrationOptionDefinitions_().find(option => option.key === normalized);
  return match || null;
}

function resolveLodgingDefinitionForInventory_(preference) {
  if (typeof getLodgingDefinitionByPreference_ === 'function') {
    const resolved = getLodgingDefinitionByPreference_(preference);
    if (resolved) return resolved;
  }
  return buildDefaultLodgingDefinition_(preference);
}

function getLodgingDefinitionByPreference_(preference) {
  const normalized = normalizeLodgingPreferenceSafe_(preference);
  if (!normalized) return null;

  if (typeof getLodgingDefinitions_ === 'function') {
    const fromDefinitions = getLodgingDefinitions_().find(def => def && def.key === normalized);
    if (fromDefinitions) {
      return Object.assign({}, fromDefinitions, {
        publicCapacity: fromDefinitions.isUnlimited ? '' : Number(fromDefinitions.publicCapacity) || 0,
        isUnlimited: !!fromDefinitions.isUnlimited,
        price: getDefaultLodgingPrice_(normalized)
      });
    }
  }

  return buildDefaultLodgingDefinition_(normalized);
}

function buildDefaultLodgingDefinition_(preference) {
  const normalized = normalizeLodgingPreferenceSafe_(preference);
  const defaults = {
    shared_cabin_connected: { publicCapacity: 120, isUnlimited: false, price: 120 },
    shared_cabin_detached: { publicCapacity: 100, isUnlimited: false, price: 100 },
    rv_hookups: { publicCapacity: 90, isUnlimited: false, price: 90 },
    tent_no_hookups: { publicCapacity: 80, isUnlimited: false, price: 80 },
    sabbath_attendance_only: { publicCapacity: 70, isUnlimited: false, price: 70 }
  };
  const match = defaults[normalized];
  if (!match) return null;
  return {
    key: normalized,
    label: normalized,
    inventoryType: 'public_capacity',
    publicCapacity: match.publicCapacity,
    isUnlimited: !!match.isUnlimited,
    price: match.price
  };
}

function getDefaultLodgingPrice_(preference) {
  const normalized = normalizeLodgingPreferenceSafe_(preference);
  const option = CONFIG && CONFIG.registrationOptions && CONFIG.registrationOptions[normalized];
  if (option && typeof option.price === 'number') return option.price;
  const fallback = buildDefaultLodgingDefinition_(normalized);
  return fallback ? fallback.price : 0;
}

function normalizeLodgingPreferenceSafe_(value) {
  if (typeof normalizeLodgingPreference_ === 'function') return normalizeLodgingPreference_(value);
  const raw = String(value || '').trim().toLowerCase();
  return raw;
}

function calculateRemainingShirtInventory_(ss, excludeRegistrationId) {
  const remaining = {};
  Object.keys(CONFIG.shirts.sizes).forEach(size => {
    remaining[size] = {
      size: size,
      capacity: Number(CONFIG.shirts.sizes[size]) || 0,
      assigned: 0,
      remaining: Number(CONFIG.shirts.sizes[size]) || 0,
      soldOut: false
    };
  });

  const rosterSheet = ss.getSheetByName(CONFIG.sheets.roster);
  if (!rosterSheet || rosterSheet.getLastRow() < 2) {
    return remaining;
  }

  const rows = rosterSheet.getRange(2, 1, rosterSheet.getLastRow() - 1, rosterSheet.getLastColumn()).getValues();
  const colMap = getColumnMap_(rosterSheet);

  rows.forEach(row => {
    const registrationId = String(row[colMap['registration_id']] || '');
    if (excludeRegistrationId && registrationId === excludeRegistrationId) return;

    const shirtSize = String(row[colMap['shirt_size']] || '').trim().toUpperCase();
    if (!shirtSize || !remaining[shirtSize]) return;

    const status = String(row[colMap['lodging_status']] || '').trim().toLowerCase();
    const ACTIVE_STATUSES = ['assigned', 'waitlisted', 'waitlist', 'manual_review'];
    if (!ACTIVE_STATUSES.includes(status)) return;

    remaining[shirtSize].assigned++;
    remaining[shirtSize].remaining = Math.max(0, remaining[shirtSize].capacity - remaining[shirtSize].assigned);
    remaining[shirtSize].soldOut = remaining[shirtSize].remaining <= 0;
  });

  return remaining;
}

function checkInventoryAvailability_(ss, normalized, excludeRegistrationId) {
  const result = {
    valid: true,
    option: null,
    shirt: null,
    messages: []
  };

  const option = getRegistrationOptionByKey_(normalized && (normalized.lodgingOptionKey || normalized.lodgingPreference || ''));
  if (!option) {
    result.valid = false;
    result.messages.push('Unknown registration option.');
    return result;
  }

  result.option = option;

  if (!option.countsAsUnlimited) {
    const lodging = calculateRemainingInventory(ss, excludeRegistrationId).byCategory[option.inventoryCategory];
    const remaining = lodging && typeof lodging.remainingPublicCapacity === 'number'
      ? lodging.remainingPublicCapacity
      : 0;
    if (remaining <= 0) {
      result.valid = false;
      result.messages.push(option.label + ' is sold out.');
    }
  }

  const shirtSize = String(normalized.shirtSize || '').trim().toUpperCase();
  if (shirtSize) {
    const shirts = calculateRemainingShirtInventory_(ss, excludeRegistrationId);
    const shirt = shirts[shirtSize];
    result.shirt = shirt || null;
    if (!shirt) {
      result.valid = false;
      result.messages.push('Unknown shirt size selected.');
    } else if (shirt.remaining <= 0) {
      result.valid = false;
      result.messages.push('Shirt size ' + shirtSize + ' is sold out.');
    }
  }

  return result;
}

function seedShirtInventorySheet_(sheet) {
  const existing = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues()
    : [];
  const existingMap = new Map(existing.map((row, idx) => [String(row[0] || '').trim().toUpperCase(), idx + 2]));

  Object.keys(CONFIG.shirts.sizes).forEach(size => {
    const rowObj = {
      shirt_size: size,
      starting_inventory: Number(CONFIG.shirts.sizes[size]) || 0,
      assigned_count: 0,
      remaining_inventory: Number(CONFIG.shirts.sizes[size]) || 0,
      sold_out: 'No',
      last_recalculated_at: '',
      notes: ''
    };
    if (existingMap.has(size)) {
      updateRowFromObject_(sheet, existingMap.get(size), {
        shirt_size: rowObj.shirt_size,
        starting_inventory: rowObj.starting_inventory
      });
    } else {
      appendRowFromObject_(sheet, rowObj);
    }
  });
}

function refreshShirtInventorySheet_(ss) {
  const sheet = ss.getSheetByName(CONFIG.sheets.shirtInventory);
  if (!sheet) return;

  seedShirtInventorySheet_(sheet);
  const inventory = calculateRemainingShirtInventory_(ss);
  const rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues()
    : [];

  rows.forEach((row, idx) => {
    const size = String(row[0] || '').trim().toUpperCase();
    const stats = inventory[size];
    if (!stats) return;
    updateRowFromObject_(sheet, idx + 2, {
      shirt_size: stats.size,
      starting_inventory: stats.capacity,
      assigned_count: stats.assigned,
      remaining_inventory: stats.remaining,
      sold_out: stats.soldOut ? 'Yes' : 'No',
      last_recalculated_at: new Date()
    });
  });
}
