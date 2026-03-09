/**
 * man-camp-registration.js
 * Man Camp attendee widget for Fluent Forms.
 *
 * Preferred hidden fields:
 *   - people_json
 *   - attendee_count
 *
 * Compatibility fields still supported:
 *   - roster_json
 *
 * Preferred container ID:
 *   - man-camp-people-container
 *
 * Compatibility container ID:
 *   - man-camp-registration-container
 *
 * TODO: match these field/container names to the production Fluent Forms build.
 */

(function () {
  'use strict';

  const CONFIG = {
    containerIds: ['man-camp-people-container', 'man-camp-registration-container'],
    hiddenFieldNames: ['people_json', 'roster_json'],
    countFieldName: 'attendee_count',
    validAgeGroups: ['adult', 'child'],
    validLodgingPreferences: ['shared_cabin_connected', 'shared_cabin_detached', 'rv_hookups', 'tent_no_hookups', 'sabbath_attendance_only'],
    validProgramTypes: ['standard', 'young_mens'],
    preferredContainerId: 'man-camp-people-container',
    gasUrl: (window.manCampRegistrationSettings && window.manCampRegistrationSettings.gasUrl) || ''
  };

  let attendees = [];

  function init() {
    injectStyles();
    const container = getContainer();
    if (!container) return;

    attendees = restoreState();
    if (!attendees.length) {
      attendees = [createAttendee(0)];
    }

    render();
    attachSubmitValidation();
    loadAvailabilityFeed();
  }

  function getContainer() {
    for (const id of CONFIG.containerIds) {
      const el = document.getElementById(id);
      if (el) return el;
    }
    return null;
  }

  function createAttendee(index) {
    return {
      id: buildPersonId(index),
      first_name: '',
      last_name: '',
      email: '',
      phone: '',
      age: '',
      age_group: 'adult',
      is_minor: false,
      is_guardian: index === 0,
      guardian_name: '',
      guardian_phone: '',
      guardian_email: '',
      guardian_relationship: '',
      guardian_link_key: '',
      guardian_registration_id: '',
      guardian_name_reference: '',
      lodging_preference: 'tent_no_hookups',
      program_type: 'standard',
      shirt_size: '',
      medical_notes: '',
      notes: ''
    };
  }

  function buildPersonId(index) {
    return 'PERS-' + String(index + 1).padStart(3, '0');
  }

  function restoreState() {
    for (const fieldName of CONFIG.hiddenFieldNames) {
      const field = findField(fieldName);
      if (!field || !field.value) continue;

      try {
        const parsed = JSON.parse(field.value);
        if (Array.isArray(parsed) && parsed.length) {
          return parsed.map((item, index) => normalizeAttendee(item, index));
        }
      } catch (err) {
        console.warn('Man Camp attendee widget could not parse', fieldName, err);
      }
    }

    return [];
  }

  function normalizeAttendee(item, index) {
    const ageGroup = CONFIG.validAgeGroups.includes(String(item.age_group || item.ageGroup || '').toLowerCase())
      ? String(item.age_group || item.ageGroup).toLowerCase()
      : 'adult';

    const lodgingPreference = normalizeLodgingPreference(item.lodging_preference || item.lodgingPreference || 'tent_no_hookups');

    return {
      id: item.id || buildPersonId(index),
      first_name: String(item.first_name || item.firstName || '').trim(),
      last_name: String(item.last_name || item.lastName || '').trim(),
      email: String(item.email || '').trim(),
      phone: String(item.phone || '').trim(),
      age: String(item.age || '').trim(),
      age_group: ageGroup,
      is_minor: toBool(item.is_minor !== undefined ? item.is_minor : false),
      is_guardian: toBool(item.is_guardian !== undefined ? item.is_guardian : item.isGuardian),
      guardian_name: String(item.guardian_name || item.guardianName || '').trim(),
      guardian_phone: String(item.guardian_phone || item.guardianPhone || '').trim(),
      guardian_email: String(item.guardian_email || item.guardianEmail || '').trim(),
      guardian_relationship: String(item.guardian_relationship || item.guardianRelationship || '').trim(),
      guardian_link_key: String(item.guardian_link_key || item.guardianLinkKey || '').trim(),
      guardian_registration_id: String(item.guardian_registration_id || item.guardianRegistrationId || '').trim(),
      guardian_name_reference: String(item.guardian_name_reference || item.guardianNameReference || '').trim(),
      lodging_preference: lodgingPreference,
      program_type: CONFIG.validProgramTypes.includes(String(item.program_type || item.programType || '').toLowerCase()) ? String(item.program_type || item.programType).toLowerCase() : 'standard',
      shirt_size: String(item.shirt_size || item.shirtSize || '').trim().toUpperCase(),
      medical_notes: String(item.medical_notes || item.medicalNotes || '').trim(),
      notes: String(item.notes || '').trim()
    };
  }

  function normalizeLodgingPreference(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'cabin_with_bath') return 'shared_cabin_connected';
    if (raw === 'cabin_without_bath') return 'shared_cabin_detached';
    if (raw === 'rv') return 'rv_hookups';
    if (raw === 'tent') return 'tent_no_hookups';
    if (raw === 'sabbath_only') return 'sabbath_attendance_only';
    return CONFIG.validLodgingPreferences.includes(raw) ? raw : raw;
  }

  function toBool(value) {
    if (typeof value === 'boolean') return value;
    const raw = String(value || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
  }

  function render() {
    const container = getContainer();
    if (!container) return;

    container.innerHTML = `
      <div class="mc-widget">
        <div class="mc-header">
          <div>
            <h3>Attendees</h3>
            <p>Enter each person in the household or group. Lodging is assigned per attendee.</p>
          </div>
          <button type="button" class="mc-add-btn">Add Attendee</button>
        </div>
        <div class="mc-summary">${buildSummary()}</div>
        <div class="mc-list">
          ${attendees.map((attendee, index) => buildCard(attendee, index)).join('')}
        </div>
        <div class="mc-footer-note">
          Children without a guardian link can still be submitted, but they will be flagged for manual review in Google Sheets.
        </div>
      </div>
    `;

    attachWidgetListeners(container);
    syncToHiddenFields();
  }

  function buildSummary() {
    const total = attendees.length;
    const adults = attendees.filter((item) => item.age_group === 'adult').length;
    const children = attendees.filter((item) => item.age_group === 'child').length;
    const guardians = attendees.filter((item) => item.is_guardian).length;
    return `
      <span><strong>${total}</strong> attendee${total === 1 ? '' : 's'}</span>
      <span>${adults} adult${adults === 1 ? '' : 's'}</span>
      <span>${children} child${children === 1 ? '' : 'ren'}</span>
      <span>${guardians} guardian${guardians === 1 ? '' : 's'}</span>
    `;
  }

  function buildCard(attendee, index) {
    const cardTitle = attendee.first_name || attendee.last_name
      ? `${escapeHtml(attendee.first_name)} ${escapeHtml(attendee.last_name)}`.trim()
      : `Attendee ${index + 1}`;

    return `
      <section class="mc-card" data-index="${index}">
        <div class="mc-card-head">
          <div>
            <div class="mc-card-badge">${escapeHtml(attendee.id)}</div>
            <h4>${escapeHtml(cardTitle)}</h4>
          </div>
          <button type="button" class="mc-remove-btn" data-index="${index}" ${attendees.length === 1 ? 'disabled' : ''}>Remove</button>
        </div>

        <div class="mc-grid">
          ${textField('First Name', 'first_name', attendee.first_name, index, true)}
          ${textField('Last Name', 'last_name', attendee.last_name, index, true)}
          ${textField('Email', 'email', attendee.email, index, false, 'email')}
          ${textField('Phone', 'phone', attendee.phone, index)}
          ${textField('Age', 'age', attendee.age, index, true, 'number')}
          ${selectField('Age Group', 'age_group', attendee.age_group, index, [
            { value: 'adult', label: 'Adult' },
            { value: 'child', label: 'Child' }
          ])}
          ${selectField('Program Type', 'program_type', attendee.program_type, index, [
            { value: 'standard', label: 'Standard' },
            { value: 'young_mens', label: "Young Men's program" }
          ])}
          ${selectField('Lodging Preference', 'lodging_preference', attendee.lodging_preference, index, [
            { value: 'shared_cabin_connected', label: 'Shared Cabin - Connected restroom, linens provided' },
            { value: 'shared_cabin_detached', label: 'Shared Cabin - Detached restroom/shower, bring your own linens' },
            { value: 'rv_hookups', label: 'RV Camping - with hookups' },
            { value: 'tent_no_hookups', label: 'Tent Camping - no hookups' },
            { value: 'sabbath_attendance_only', label: 'Sabbath Attendance only' }
          ])}
          ${textField('Shirt Size', 'shirt_size', attendee.shirt_size, index, true)}
          ${checkboxField('Guardian', 'is_guardian', attendee.is_guardian, index)}
          ${textField('Guardian Name', 'guardian_name', attendee.guardian_name, index)}
          ${textField('Guardian Phone', 'guardian_phone', attendee.guardian_phone, index)}
          ${textField('Guardian Email', 'guardian_email', attendee.guardian_email, index, false, 'email')}
          ${textField('Guardian Relationship', 'guardian_relationship', attendee.guardian_relationship, index)}
          ${textField('Guardian Link Key', 'guardian_link_key', attendee.guardian_link_key, index, false, 'text', 'Shared key for linked guardian + child records')}
          ${textField('Guardian Registration ID', 'guardian_registration_id', attendee.guardian_registration_id, index)}
          ${textField('Guardian Name Reference', 'guardian_name_reference', attendee.guardian_name_reference, index, false, 'text', 'Optional human-readable guardian reference')}
          ${textareaField('Medical / Special Considerations', 'medical_notes', attendee.medical_notes, index)}
          ${textareaField('Notes', 'notes', attendee.notes, index)}
        </div>
      </section>
    `;
  }

  function textField(label, field, value, index, required, type, helpText) {
    return `
      <label class="mc-field ${field === 'guardian_link_key' || field === 'guardian_registration_id' || field === 'guardian_name_reference' ? 'mc-span-2' : ''}">
        <span>${label}${required ? ' *' : ''}</span>
        <input
          type="${type || 'text'}"
          class="mc-input"
          data-field="${field}"
          data-index="${index}"
          value="${escapeAttr(value)}"
          ${required ? 'required' : ''}>
        ${helpText ? `<small>${escapeHtml(helpText)}</small>` : ''}
      </label>
    `;
  }

  function selectField(label, field, value, index, options) {
    return `
      <label class="mc-field">
        <span>${label} *</span>
        <select class="mc-input" data-field="${field}" data-index="${index}">
          ${options.map((option) => `
            <option value="${option.value}" ${option.value === value ? 'selected' : ''}>${option.label}</option>
          `).join('')}
        </select>
      </label>
    `;
  }

  function checkboxField(label, field, checked, index) {
    return `
      <label class="mc-field mc-checkbox">
        <span>${label}</span>
        <input
          type="checkbox"
          data-field="${field}"
          data-index="${index}"
          ${checked ? 'checked' : ''}>
      </label>
    `;
  }

  function textareaField(label, field, value, index) {
    return `
      <label class="mc-field mc-span-2">
        <span>${label}</span>
        <textarea class="mc-input" rows="3" data-field="${field}" data-index="${index}">${escapeHtml(value)}</textarea>
      </label>
    `;
  }

  function attachWidgetListeners(container) {
    const addBtn = container.querySelector('.mc-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        attendees.push(createAttendee(attendees.length));
        render();
      });
    }

    container.querySelectorAll('.mc-remove-btn').forEach((button) => {
      button.addEventListener('click', function () {
        const index = Number(this.dataset.index);
        if (Number.isNaN(index) || attendees.length === 1) return;
        attendees.splice(index, 1);
        attendees = attendees.map((attendee, attendeeIndex) => ({
          ...attendee,
          id: buildPersonId(attendeeIndex)
        }));
        render();
      });
    });

    container.querySelectorAll('[data-field]').forEach((field) => {
      const eventName = field.type === 'checkbox' || field.tagName === 'SELECT' ? 'change' : 'input';
      field.addEventListener(eventName, handleFieldChange);
      if (eventName !== 'change') {
        field.addEventListener('change', handleFieldChange);
      }
    });
  }

  function handleFieldChange(event) {
    const field = event.currentTarget;
    const index = Number(field.dataset.index);
    const key = field.dataset.field;
    if (Number.isNaN(index) || !attendees[index] || !key) return;

    attendees[index][key] = field.type === 'checkbox' ? field.checked : field.value;
    if (key === 'age') {
      const age = Number(field.value);
      attendees[index].is_minor = !Number.isNaN(age) && age < 18;
      attendees[index].age_group = attendees[index].is_minor ? 'child' : 'adult';
    }
    syncToHiddenFields();

    if (key === 'age_group' || key === 'is_guardian' || key === 'age') {
      render();
    }
  }

  function syncToHiddenFields() {
    const payload = attendees.map((attendee, index) => ({
      id: attendee.id || buildPersonId(index),
      first_name: String(attendee.first_name || '').trim(),
      last_name: String(attendee.last_name || '').trim(),
      email: String(attendee.email || '').trim(),
      phone: String(attendee.phone || '').trim(),
      age: String(attendee.age || '').trim(),
      age_group: CONFIG.validAgeGroups.includes(String(attendee.age_group || '').toLowerCase())
        ? String(attendee.age_group).toLowerCase()
        : 'adult',
      is_minor: !!attendee.is_minor,
      is_guardian: !!attendee.is_guardian,
      guardian_name: String(attendee.guardian_name || '').trim(),
      guardian_phone: String(attendee.guardian_phone || '').trim(),
      guardian_email: String(attendee.guardian_email || '').trim(),
      guardian_relationship: String(attendee.guardian_relationship || '').trim(),
      guardian_link_key: String(attendee.guardian_link_key || '').trim(),
      guardian_registration_id: String(attendee.guardian_registration_id || '').trim(),
      guardian_name_reference: String(attendee.guardian_name_reference || '').trim(),
      lodging_preference: normalizeLodgingPreference(attendee.lodging_preference || ''),
      lodging_option_key: normalizeLodgingPreference(attendee.lodging_preference || ''),
      program_type: CONFIG.validProgramTypes.includes(String(attendee.program_type || '').toLowerCase())
        ? String(attendee.program_type).toLowerCase()
        : 'standard',
      shirt_size: String(attendee.shirt_size || '').trim().toUpperCase(),
      medical_notes: String(attendee.medical_notes || '').trim(),
      notes: String(attendee.notes || '').trim()
    }));

    CONFIG.hiddenFieldNames.forEach((fieldName) => {
      const field = findField(fieldName);
      if (!field) return;
      field.value = JSON.stringify(payload);
      dispatchFieldEvents(field);
    });

    const countField = findField(CONFIG.countFieldName);
    if (countField) {
      countField.value = String(payload.length);
      dispatchFieldEvents(countField);
    }
  }

  function findField(name) {
    return document.querySelector(`input[name="${name}"], textarea[name="${name}"], input[data-name="${name}"], textarea[data-name="${name}"]`);
  }

  function dispatchFieldEvents(field) {
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function validateAttendees() {
    const errors = [];

    if (!attendees.length) {
      errors.push('Add at least one attendee before continuing.');
      return errors;
    }

    attendees.forEach((attendee, index) => {
      const label = `Attendee ${index + 1}`;
      if (!String(attendee.first_name || '').trim()) {
        errors.push(`${label}: first name is required.`);
      }
      if (!String(attendee.last_name || '').trim()) {
        errors.push(`${label}: last name is required.`);
      }
      if (!String(attendee.age || '').trim()) {
        errors.push(`${label}: age is required.`);
      }
      if (!String(attendee.shirt_size || '').trim()) {
        errors.push(`${label}: shirt size is required.`);
      }
      const age = Number(attendee.age);
      if (String(attendee.program_type || '') === 'young_mens' && (Number.isNaN(age) || age < 10 || age > 14)) {
        errors.push(`${label}: Young Men's program is only for ages 10-14.`);
      }
      if (!Number.isNaN(age) && age < 18) {
        if (!String(attendee.guardian_name || '').trim() || !String(attendee.guardian_phone || '').trim() || !String(attendee.guardian_email || '').trim() || !String(attendee.guardian_relationship || '').trim()) {
          errors.push(`${label}: minors must include guardian name, phone, email, and relationship.`);
        }
      }

      const lodgingPreference = normalizeLodgingPreference(attendee.lodging_preference || '');
      if (!CONFIG.validLodgingPreferences.includes(lodgingPreference)) {
        errors.push(`${label}: select a valid Man Camp registration option.`);
      }
    });

    return errors;
  }

  function attachSubmitValidation() {
    const tryAttach = function () {
      const container = getContainer();
      if (!container) return false;

      const form = container.closest('form');
      if (!form || form.dataset.manCampWidgetBound === '1') return !!form;
      form.dataset.manCampWidgetBound = '1';

      form.addEventListener('click', function (event) {
        const button = event.target.closest('.ff-btn-next, .ff-btn-submit, [type="submit"]');
        if (!button) return;

        if (!isVisible(container)) return;

        const errors = validateAttendees();
        if (errors.length) {
          event.preventDefault();
          event.stopImmediatePropagation();
          showErrors(errors);
          return false;
        }

        syncToHiddenFields();
        return true;
      }, true);

      return true;
    };

    if (tryAttach()) return;

    const intervalId = window.setInterval(function () {
      if (tryAttach()) {
        window.clearInterval(intervalId);
      }
    }, 300);

    window.setTimeout(function () {
      window.clearInterval(intervalId);
    }, 10000);
  }

  function showErrors(errors) {
    const container = getContainer();
    if (!container) return;

    const existing = container.querySelector('.mc-errors');
    if (existing) existing.remove();

    const wrapper = document.createElement('div');
    wrapper.className = 'mc-errors';
    wrapper.innerHTML = `
      <strong>Please fix these issues before continuing:</strong>
      <ul>${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>
    `;

    const widget = container.querySelector('.mc-widget');
    if (widget) {
      widget.appendChild(wrapper);
      wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function isVisible(element) {
    return element.offsetParent !== null && element.getBoundingClientRect().width > 0;
  }

  function injectStyles() {
    if (document.getElementById('man-camp-attendee-widget-styles')) return;

    const style = document.createElement('style');
    style.id = 'man-camp-attendee-widget-styles';
    style.textContent = `
      .mc-widget { border: 1px solid #d8dee6; border-radius: 12px; padding: 20px; background: #fbfcfd; }
      .mc-header { display: flex; justify-content: space-between; gap: 16px; align-items: start; margin-bottom: 16px; }
      .mc-header h3 { margin: 0 0 4px; font-size: 22px; }
      .mc-header p { margin: 0; color: #4f5d6b; }
      .mc-add-btn, .mc-remove-btn { background: #1d4f5f; color: #fff; border: 0; border-radius: 8px; padding: 10px 14px; cursor: pointer; }
      .mc-remove-btn[disabled] { opacity: 0.45; cursor: default; }
      .mc-summary { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 16px; color: #30424d; font-size: 14px; }
      .mc-list { display: grid; gap: 16px; }
      .mc-card { border: 1px solid #dfe6eb; border-radius: 10px; background: #fff; padding: 16px; }
      .mc-card-head { display: flex; justify-content: space-between; gap: 16px; align-items: start; margin-bottom: 14px; }
      .mc-card-head h4 { margin: 6px 0 0; font-size: 18px; }
      .mc-card-badge { display: inline-block; padding: 4px 8px; border-radius: 999px; background: #eef4f6; color: #1d4f5f; font-size: 12px; font-weight: 700; }
      .mc-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .mc-field { display: flex; flex-direction: column; gap: 6px; font-size: 14px; color: #22313a; }
      .mc-field small { color: #5a6c78; }
      .mc-span-2 { grid-column: span 2; }
      .mc-input { width: 100%; border: 1px solid #c9d4db; border-radius: 8px; padding: 10px 12px; font: inherit; box-sizing: border-box; background: #fff; }
      .mc-checkbox { justify-content: end; }
      .mc-checkbox input { width: 18px; height: 18px; }
      .mc-footer-note { margin-top: 14px; color: #5a6c78; font-size: 13px; }
      .mc-errors { margin-top: 16px; border-radius: 10px; background: #fff3f2; color: #7a1d17; padding: 12px 14px; }
      .mc-errors ul { margin: 8px 0 0 18px; }
      .mc-avail-badge { display: inline-block; margin-left: 8px; font-size: 11px; font-weight: 700; color: #8a5300; }
      .mc-sold-out { opacity: 0.55; }
      @media (max-width: 700px) {
        .mc-header { flex-direction: column; }
        .mc-grid { grid-template-columns: 1fr; }
        .mc-span-2 { grid-column: span 1; }
      }
    `;

    document.head.appendChild(style);
  }

  function loadAvailabilityFeed() {
    if (!CONFIG.gasUrl || typeof window.fetch !== 'function') return;
    window.fetch(CONFIG.gasUrl + '?action=getAvailability')
      .then((response) => response.json())
      .then((data) => {
        if (data && data.success) applyAvailabilityToForm(data);
      })
      .catch(() => {});
  }

  function applyAvailabilityToForm(data) {
    (data.options || []).forEach((option) => {
      const matched = Array.from(document.querySelectorAll('input, option')).filter((el) => {
        const value = String(el.value || '').trim().toLowerCase();
        const explicit = String(el.getAttribute('data-mancamp-option-key') || '').trim().toLowerCase();
        const label = String(el.textContent || '').trim().toLowerCase();
        return value === option.optionKey || explicit === option.optionKey || label.indexOf(String(option.optionLabel || '').toLowerCase()) >= 0;
      });

      matched.forEach((el) => {
        if ('disabled' in el) el.disabled = !!option.soldOut;
        const wrapper = el.closest('.ff-el-form-check, .ff-el-group, label') || el.parentElement;
        if (!wrapper) return;
        wrapper.classList.toggle('mc-sold-out', !!option.soldOut);
        const existing = wrapper.querySelector('.mc-avail-badge');
        if (existing) existing.remove();
        const badge = document.createElement('span');
        badge.className = 'mc-avail-badge';
        badge.textContent = option.soldOut
          ? (option.waitlistAllowed ? 'WAITLIST' : 'SOLD OUT')
          : (option.available === 'Unlimited' ? 'AVAILABLE' : `${option.available} left`);
        wrapper.appendChild(badge);
      });
    });

    Object.values(data.shirts || {}).forEach((shirt) => {
      const matched = Array.from(document.querySelectorAll('input, option')).filter((el) => {
        const value = String(el.value || '').trim().toUpperCase();
        const explicit = String(el.getAttribute('data-mancamp-shirt-size') || '').trim().toUpperCase();
        return value === shirt.size || explicit === shirt.size;
      });
      matched.forEach((el) => {
        if ('disabled' in el) el.disabled = !!shirt.soldOut;
      });
    });
  }

  function escapeAttr(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  document.addEventListener('DOMContentLoaded', init);
  document.addEventListener('fluentform_step_changed', init);
})();
