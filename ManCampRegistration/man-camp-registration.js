/**
 * Man Camp 2026 Fluent Forms widget.
 *
 * Renders the lodging / roster builder into `#mancamp-builder`, keeps the
 * hidden-field contract in sync, and validates guardian, program, pricing,
 * payment-method, and shirt-inventory rules before submission.
 */

(function () {
  'use strict';

  const settings = window.manCampRegistrationSettings || {};
  const CONTRACT = Object.assign({
    containerId: 'mancamp-builder',
    peopleField: 'people_json',
    rosterField: 'roster_json',
    attendeeCountField: 'attendee_count',
    lodgingOptionKeyField: 'lodging_option_key',
    lodgingOptionLabelField: 'lodging_option_label',
    lodgingRequestField: 'lodging_request_json',
    rvAmpField: 'rv_amp',
    rvLengthField: 'rv_length',
    registrationTotalField: 'registration_total',
    processingFeeField: 'processing_fee',
    paymentMethodField: 'payment_method',
    payTypeField: 'pay_type',
    customPaymentAmountFields: ['custom_payment_amount', 'custom-payment-amount']
  }, settings.fieldContract || {});

  const PROGRAMS = {
    standard: { key: 'standard', label: 'Standard Program' },
    young_mens: { key: 'young_mens', label: "Young Men's Program", minAge: 10, maxAge: 14 }
  };

  const LODGING_OPTIONS = [
    { key: 'shared_cabin_connected', label: 'Shared Cabin - Connected Restroom', price: 120 },
    { key: 'shared_cabin_detached', label: 'Shared Cabin - Detached Restroom/Shower', price: 100 },
    { key: 'rv_hookups', label: 'RV Hookups', price: 90 },
    { key: 'tent_no_hookups', label: 'Tent Camping - No Hookups', price: 80 },
    { key: 'sabbath_attendance_only', label: 'Sabbath Attendance Only', price: 70 }
  ];

  const ATTENDANCE_OPTIONS = [
    { key: 'overnight', label: 'Overnight' },
    { key: 'sabbath_only', label: 'Sabbath Only' }
  ];

  const SHIRT_SIZES = ['M', 'L', 'XL', '2XL', '3XL', '4XL'];
  const DEFAULT_OFFLINE_VALUES = ['offline', 'check', 'cash'];
  const SQUARE_FEE_RATE = 0.029;
  const SQUARE_FEE_FIXED = 0.30;
  const SABBATH_ONLY_PRICE = 70;
  const RETRY_LIMIT = 40;
  const RETRY_DELAY_MS = 250;

  function roundCurrency(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
  }

  function formatMoney(value) {
    return roundCurrency(value).toFixed(2);
  }

  function slugify(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'attendee';
  }

  function optionByKey(key) {
    return LODGING_OPTIONS.find((option) => option.key === key) || LODGING_OPTIONS[0];
  }

  function canonicalLodgingKey(rawValue) {
    const raw = String(rawValue || '').trim().toLowerCase();
    if (!raw) return LODGING_OPTIONS[0].key;
    if (raw === 'cabin_connected' || raw === 'shared_cabin_connected') return 'shared_cabin_connected';
    if (raw === 'cabin_detached' || raw === 'shared_cabin_detached') return 'shared_cabin_detached';
    if (raw === 'sabbath_only' || raw === 'sabbath_attendance_only') return 'sabbath_attendance_only';
    if (LODGING_OPTIONS.some((option) => option.key === raw)) return raw;
    return LODGING_OPTIONS[0].key;
  }

  function parseAge(value) {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function ageGroupFor(age) {
    return typeof age === 'number' && age < 18 ? 'child' : 'adult';
  }

  function guardianLinkKeyFor(person, index) {
    return `${slugify(person.first_name)}-${slugify(person.last_name)}-${index}`;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function buildSelectOptions(selectedValue, choices) {
    return choices.map((choice) => {
      const selected = String(selectedValue) === String(choice.value) ? ' selected' : '';
      const disabled = choice.disabled ? ' disabled' : '';
      return `<option value="${escapeHtml(choice.value)}"${selected}${disabled}>${escapeHtml(choice.label)}</option>`;
    }).join('');
  }

  function parseOfflineValues(rawValue) {
    if (!rawValue) return DEFAULT_OFFLINE_VALUES.slice();
    try {
      const parsed = JSON.parse(rawValue);
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);
      }
    } catch (error) {
      // Fallback to CSV-style parsing below.
    }
    return String(rawValue)
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }

  function findPaymentMethodControl(form) {
    return form.querySelector('[data-payment-method], input[name="payment_method"], select[name="payment_method"]');
  }

  function resolvePaymentMethod(form, offlineValues) {
    const paymentMethodField = findPaymentMethodControl(form);
    if (!paymentMethodField) {
      return { raw: '', normalized: 'square' };
    }

    let rawValue = '';
    if (paymentMethodField.matches('select')) {
      rawValue = paymentMethodField.value;
    } else if (paymentMethodField.matches('input[type="radio"][name="payment_method"]')) {
      const checked = form.querySelector('input[name="payment_method"]:checked');
      rawValue = checked ? checked.value : '';
    } else if (paymentMethodField.matches('input[type="hidden"], input[type="text"], input:not([type])')) {
      rawValue = paymentMethodField.value;
    } else {
      const checked = paymentMethodField.querySelector ? paymentMethodField.querySelector('input[name="payment_method"]:checked') : null;
      rawValue = checked ? checked.value : (paymentMethodField.value || paymentMethodField.getAttribute('data-payment-method') || '');
    }

    const normalizedRaw = String(rawValue || '').trim().toLowerCase();
    const normalized = normalizedRaw === 'square' || normalizedRaw === '' || !offlineValues.includes(normalizedRaw)
      ? 'square'
      : 'offline';

    return { raw: normalizedRaw, normalized };
  }

  function createPersonBase(person, index, allPeople) {
    const age = parseAge(person.age);
    const ageGroup = ageGroupFor(age);
    const isAdult = ageGroup === 'adult';
    const guardianIndex = Number.isInteger(person.guardianIndex) ? person.guardianIndex : null;
    const guardian = guardianIndex !== null ? allPeople[guardianIndex] || null : null;
    const guardianLinkKey = guardian ? guardianLinkKeyFor(guardian, guardianIndex) : '';
    const isPrimary = index === 0;
    const isGuardian = isAdult && allPeople.some((candidate, candidateIndex) => {
      if (candidateIndex === index) return false;
      return Number.isInteger(candidate.guardianIndex) && candidate.guardianIndex === index;
    });

    return {
      first_name: String(person.first_name || '').trim(),
      last_name: String(person.last_name || '').trim(),
      email: String(person.email || '').trim(),
      phone: String(person.phone || '').trim(),
      age: age,
      age_group: ageGroup,
      program: person.program === PROGRAMS.young_mens.key ? PROGRAMS.young_mens.key : PROGRAMS.standard.key,
      shirt: String(person.shirt || '').trim().toUpperCase(),
      volunteer: person.volunteer === 'yes' ? 'yes' : 'no',
      attendance_type: person.attendance_type === 'sabbath_only' ? 'sabbath_only' : 'overnight',
      is_guardian: isGuardian,
      guardian_link_key: guardianLinkKey,
      is_primary: isPrimary
    };
  }

  function getEffectiveShirtInventory(serverInventory, people, excludeIndex) {
    const counts = {};
    people.forEach((person, index) => {
      if (index === excludeIndex) return;
      const size = String(person.shirt || '').trim().toUpperCase();
      if (!size) return;
      counts[size] = (counts[size] || 0) + 1;
    });

    return SHIRT_SIZES.reduce((acc, size) => {
      const entry = serverInventory && serverInventory[size] ? serverInventory[size] : null;
      const remaining = entry && typeof entry.remaining === 'number'
        ? Math.max(0, entry.remaining - (counts[size] || 0))
        : null;
      acc[size] = {
        remaining,
        label: size
      };
      if (remaining === 0) {
        acc[size].label = `${size} (Sold Out)`;
      } else if (remaining !== null && remaining <= 3) {
        acc[size].label = `${size} (Only ${remaining} left)`;
      }
      acc[size].disabled = remaining === 0;
      return acc;
    }, {});
  }

  function injectExternalError(field, message, slotId) {
    if (!field) return;
    let slot = field.form.querySelector(`[data-mc-error-slot="${slotId}"]`);
    if (!slot) {
      slot = document.createElement('div');
      slot.setAttribute('data-mc-error-slot', slotId);
      slot.style.color = '#b42318';
      slot.style.fontSize = '12px';
      slot.style.marginTop = '4px';
      field.insertAdjacentElement('afterend', slot);
    }
    slot.textContent = message || '';
    slot.style.display = message ? 'block' : 'none';
  }

  function noTranslateField(field) {
    if (!field) return;
    field.setAttribute('translate', 'no');
    field.classList.add('notranslate');
  }

  function initWidget(container, form) {
    const offlineValues = parseOfflineValues(container.getAttribute('data-offline-values'));
    const gasUrl = container.getAttribute('data-gas-url') || settings.gasUrl || '';
    const primaryFields = {
      first_name: getField(form, 'first_name'),
      last_name: getField(form, 'last_name'),
      email: getField(form, 'email'),
      phone: getField(form, 'phone'),
      age: getField(form, 'age') || getField(form, 'ageNum')
    };

    const initialLodging = canonicalLodgingKey(readFieldValue(form, CONTRACT.lodgingOptionKeyField));
    const state = {
      container,
      form,
      gasUrl,
      offlineValues,
      shirtInventory: null,
      primaryExtras: {
        attendance_type: 'overnight',
        program: PROGRAMS.standard.key,
        shirt: '',
        volunteer: 'no',
        guardianIndex: null
      },
      lodging: {
        type: initialLodging,
        rvAmp: readFieldValue(form, CONTRACT.rvAmpField) || '',
        rvLengthFeet: readFieldValue(form, CONTRACT.rvLengthField) || '',
        notes: ''
      },
      draft: {
        first_name: '',
        last_name: '',
        age: '',
        attendance_type: 'overnight',
        program: PROGRAMS.standard.key,
        shirt: '',
        volunteer: 'no',
        guardianIndex: null
      },
      additionalPeople: [],
      externalErrors: {},
      primaryErrors: {},
      draftErrors: {},
      rosterError: '',
      availabilityWarning: '',
      paymentMethod: 'square'
    };

    function readPrimaryPerson() {
      return {
        first_name: readFieldValue(form, 'first_name'),
        last_name: readFieldValue(form, 'last_name'),
        email: readFieldValue(form, 'email'),
        phone: readFieldValue(form, 'phone'),
        age: readFieldValue(form, 'age') || readFieldValue(form, 'ageNum'),
        attendance_type: state.primaryExtras.attendance_type,
        program: state.primaryExtras.program,
        shirt: state.primaryExtras.shirt,
        volunteer: state.primaryExtras.volunteer,
        guardianIndex: state.primaryExtras.guardianIndex,
        _guardianResetWarning: state.primaryExtras._guardianResetWarning || ''
      };
    }

    function allPeopleRaw() {
      return [readPrimaryPerson()].concat(state.additionalPeople.map((person) => Object.assign({}, person)));
    }

    function adultsForGuardians(people, excludeIndex) {
      return people
        .map((person, index) => ({ person, index }))
        .filter(({ person, index }) => index !== excludeIndex && ageGroupFor(parseAge(person.age)) === 'adult');
    }

    function validateProgramAge(age, program) {
      if (program !== PROGRAMS.young_mens.key) return '';
      const parsedAge = parseAge(age);
      if (parsedAge === null || parsedAge < PROGRAMS.young_mens.minAge || parsedAge > PROGRAMS.young_mens.maxAge) {
        return 'Young Men\'s Program is for ages 10–14 only.';
      }
      return '';
    }

    function defaultGuardianIndexForChild(people) {
      const primaryAge = parseAge(people[0] && people[0].age);
      return ageGroupFor(primaryAge) === 'adult' ? 0 : null;
    }

    function validatePrimary() {
      const person = readPrimaryPerson();
      const people = allPeopleRaw();
      const errors = {};
      const age = parseAge(person.age);
      const adults = adultsForGuardians(people, 0);

      if (!person.first_name.trim()) errors.first_name = 'First name is required.';
      if (!person.last_name.trim()) errors.last_name = 'Last name is required.';
      if (age === null) errors.age = 'Age is required.';

      const programError = validateProgramAge(age, person.program);
      if (programError) errors.program = programError;

      if (!person.shirt) errors.shirt = 'Shirt size is required.';

      if (age !== null && age < 18) {
        if (!adults.length) {
          errors.guardian = 'A guardian must be added before registering a child.';
        } else if (!Number.isInteger(person.guardianIndex)) {
          errors.guardian = 'Guardian selection is required for minors.';
        }
      }

      state.externalErrors = {
        first_name: errors.first_name || '',
        last_name: errors.last_name || '',
        age: errors.age || ''
      };
      state.primaryErrors = {
        program: errors.program || '',
        shirt: errors.shirt || '',
        guardian: errors.guardian || ''
      };

      return Object.values(errors).filter(Boolean).length === 0;
    }

    function validateDraft() {
      const people = allPeopleRaw();
      const adults = adultsForGuardians(people, null);
      const age = parseAge(state.draft.age);
      const errors = {};

      if (!state.draft.first_name.trim()) errors.first_name = 'First name is required.';
      if (!state.draft.last_name.trim()) errors.last_name = 'Last name is required.';
      if (age === null) errors.age = 'Age is required.';

      const programError = validateProgramAge(age, state.draft.program);
      if (programError) errors.program = programError;

      if (!state.draft.shirt) errors.shirt = 'Shirt size is required.';

      if (age !== null && age < 18) {
        if (!adults.length) {
          errors.guardian = 'A guardian must be added before registering a child.';
        } else if (!Number.isInteger(state.draft.guardianIndex)) {
          errors.guardian = 'Guardian selection is required for minors.';
        }
      }

      state.draftErrors = errors;
      return Object.keys(errors).length === 0;
    }

    function serializePeople() {
      const rawPeople = allPeopleRaw();
      const basePeople = rawPeople.map((person, index) => createPersonBase(person, index, rawPeople));

      return basePeople.map((person, index) => {
        const guardianIndex = Number.isInteger(rawPeople[index].guardianIndex) ? rawPeople[index].guardianIndex : null;
        const guardianLabel = guardianIndex !== null && rawPeople[guardianIndex]
          ? `${rawPeople[guardianIndex].first_name} ${rawPeople[guardianIndex].last_name}`.trim()
          : '';
        const warnings = [];

        if (rawPeople[index]._guardianResetWarning) {
          warnings.push(rawPeople[index]._guardianResetWarning);
        }
        if (person.program === PROGRAMS.young_mens.key && !person.guardian_link_key) {
          warnings.push('Guardian required for Young Men\'s Program.');
        }
        if (parseAge(person.age) !== null && parseAge(person.age) < 18 && !person.guardian_link_key) {
          warnings.push('Guardian required.');
        }

        return Object.assign({}, person, {
          guardian_label: guardianLabel,
          _warnings: warnings
        });
      });
    }

    function calculateTotals(people, paymentMethod) {
      const lodging = optionByKey(state.lodging.type);
      let overnightCount = 0;
      let sabbathOnlyCount = 0;
      let baseTotal = 0;

      people.forEach((person) => {
        if (person.volunteer === 'yes') return;
        if (person.attendance_type === 'sabbath_only') {
          sabbathOnlyCount += 1;
          baseTotal += SABBATH_ONLY_PRICE;
          return;
        }
        overnightCount += 1;
        baseTotal += lodging.price;
      });

      const roundedBase = roundCurrency(baseTotal);
      const processingFee = paymentMethod === 'square'
        ? roundCurrency((roundedBase * SQUARE_FEE_RATE) + SQUARE_FEE_FIXED)
        : 0;
      const customPaymentAmount = roundCurrency(roundedBase + processingFee);

      return {
        baseTotal: roundedBase,
        processingFee,
        customPaymentAmount,
        overnightCount,
        sabbathOnlyCount,
        overnightPrice: lodging.price
      };
    }

    function lodgingRequest() {
      return {
        type: state.lodging.type,
        rvAmp: state.lodging.type === 'rv_hookups' ? (state.lodging.rvAmp || '') : null,
        rvLengthFeet: state.lodging.type === 'rv_hookups' && state.lodging.rvLengthFeet !== ''
          ? Number(state.lodging.rvLengthFeet)
          : null,
        notes: state.lodging.notes || ''
      };
    }

    function syncHiddenFields() {
      const paymentState = resolvePaymentMethod(form, state.offlineValues);
      state.paymentMethod = paymentState.normalized;

      const people = serializePeople();
      const totals = calculateTotals(people, state.paymentMethod);
      const lodging = optionByKey(state.lodging.type);
      const payloadPeople = people.map((person) => ({
        first_name: person.first_name,
        last_name: person.last_name,
        age: person.age,
        age_group: person.age_group,
        program: person.program,
        shirt: person.shirt,
        volunteer: person.volunteer,
        attendance_type: person.attendance_type,
        is_guardian: person.is_guardian,
        guardian_link_key: person.guardian_link_key,
        is_primary: person.is_primary
      }));
      const peopleJson = JSON.stringify(payloadPeople);
      const lodgingJson = JSON.stringify(lodgingRequest());

      setFieldValue(form, CONTRACT.peopleField, peopleJson);
      setFieldValue(form, 'attendees_json', peopleJson);
      setFieldValue(form, CONTRACT.rosterField, peopleJson);
      setFieldValue(form, CONTRACT.attendeeCountField, String(payloadPeople.length));
      setFieldValue(form, CONTRACT.lodgingOptionKeyField, lodging.key);
      setFieldValue(form, CONTRACT.lodgingOptionLabelField, lodging.label);
      setFieldValue(form, CONTRACT.lodgingRequestField, lodgingJson);
      setFieldValue(form, CONTRACT.rvAmpField, state.lodging.type === 'rv_hookups' ? (state.lodging.rvAmp || '') : '');
      setFieldValue(form, CONTRACT.rvLengthField, state.lodging.type === 'rv_hookups' ? (state.lodging.rvLengthFeet || '') : '');
      setFieldValue(form, CONTRACT.registrationTotalField, formatMoney(totals.baseTotal));
      setFieldValue(form, CONTRACT.processingFeeField, formatMoney(totals.processingFee));
      setFieldValue(form, CONTRACT.paymentMethodField, state.paymentMethod);
      setFieldValue(form, CONTRACT.payTypeField, state.paymentMethod);
      CONTRACT.customPaymentAmountFields.forEach((name) => {
        setFieldValue(form, name, formatMoney(totals.customPaymentAmount));
      });

      noTranslateField(getField(form, CONTRACT.peopleField));
      noTranslateField(getField(form, 'attendees_json'));
      noTranslateField(getField(form, CONTRACT.rosterField));
      noTranslateField(getField(form, CONTRACT.lodgingRequestField));
      noTranslateField(getField(form, CONTRACT.registrationTotalField));
      noTranslateField(getField(form, CONTRACT.processingFeeField));
      CONTRACT.customPaymentAmountFields.forEach((name) => noTranslateField(getField(form, name)));

      return { people, totals, lodging };
    }

    function render() {
      const rawPeople = allPeopleRaw();
      const adultsForDraft = adultsForGuardians(rawPeople, null);
      const adultsForPrimary = adultsForGuardians(rawPeople, 0);
      const primaryAge = parseAge(rawPeople[0].age);
      const draftAge = parseAge(state.draft.age);
      const synced = syncHiddenFields();
      const people = synced.people;
      const totals = synced.totals;
      const primaryShirts = getEffectiveShirtInventory(state.shirtInventory, rawPeople, 0);
      const draftShirts = getEffectiveShirtInventory(state.shirtInventory, rawPeople.concat([state.draft]), rawPeople.length);

      const primaryGuardianOptions = [{ value: '', label: 'Select guardian' }].concat(
        adultsForPrimary.map(({ person, index }) => ({
          value: String(index),
          label: `${person.first_name} ${person.last_name}`.trim()
        }))
      );
      const draftGuardianOptions = [{ value: '', label: 'Select guardian' }].concat(
        adultsForDraft.map(({ person, index }) => ({
          value: String(index),
          label: `${person.first_name} ${person.last_name}`.trim()
        }))
      );

      const primaryProgramError = state.primaryErrors.program || '';
      const showPrimaryGuardian = primaryAge !== null && primaryAge < 18;
      const showDraftGuardian = draftAge !== null && draftAge < 18;
      const lodgingOption = optionByKey(state.lodging.type);

      container.innerHTML = `
        <div class="mc-builder">
          <style>
            #${CONTRACT.containerId} .mc-builder { border: 1px solid #d0d5dd; border-radius: 16px; padding: 20px; background: linear-gradient(180deg, #f8fbff 0%, #ffffff 100%); color: #12212f; }
            #${CONTRACT.containerId} .mc-grid { display: grid; gap: 18px; }
            #${CONTRACT.containerId} .mc-grid.two { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
            #${CONTRACT.containerId} .mc-card { border: 1px solid #d7e2ec; border-radius: 14px; background: #fff; padding: 16px; }
            #${CONTRACT.containerId} h3 { margin: 0 0 12px; font-size: 18px; }
            #${CONTRACT.containerId} .mc-field { display: flex; flex-direction: column; gap: 6px; }
            #${CONTRACT.containerId} label { font-size: 13px; font-weight: 600; color: #29465b; }
            #${CONTRACT.containerId} input, #${CONTRACT.containerId} select, #${CONTRACT.containerId} textarea { width: 100%; border: 1px solid #c6d2dc; border-radius: 10px; padding: 10px 12px; font: inherit; box-sizing: border-box; background: #fff; }
            #${CONTRACT.containerId} .mc-inline-error { color: #b42318; font-size: 12px; min-height: 16px; }
            #${CONTRACT.containerId} .mc-inline-warning { color: #9a6700; font-size: 12px; min-height: 16px; }
            #${CONTRACT.containerId} .mc-lodging-options { display: grid; gap: 10px; }
            #${CONTRACT.containerId} .mc-option { border: 1px solid #d7e2ec; border-radius: 12px; padding: 12px; display: flex; gap: 10px; align-items: flex-start; }
            #${CONTRACT.containerId} .mc-option strong { display: block; }
            #${CONTRACT.containerId} .mc-summary { background: #12344d; color: #fff; border-radius: 14px; padding: 16px; }
            #${CONTRACT.containerId} .mc-summary .muted { color: #c8d7e3; }
            #${CONTRACT.containerId} table { width: 100%; border-collapse: collapse; }
            #${CONTRACT.containerId} th, #${CONTRACT.containerId} td { text-align: left; padding: 10px 8px; border-top: 1px solid #e4ebf1; vertical-align: top; font-size: 13px; }
            #${CONTRACT.containerId} th { color: #29465b; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
            #${CONTRACT.containerId} .mc-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #edf5ff; color: #164c7e; font-size: 12px; }
            #${CONTRACT.containerId} .mc-warning-list { color: #9a6700; font-size: 12px; }
            #${CONTRACT.containerId} .mc-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
            #${CONTRACT.containerId} button { border: 0; border-radius: 999px; padding: 10px 16px; font: inherit; cursor: pointer; }
            #${CONTRACT.containerId} .mc-primary-button { background: #145da0; color: #fff; }
            #${CONTRACT.containerId} .mc-secondary-button { background: #eef4fa; color: #16344d; }
            @media (max-width: 680px) {
              #${CONTRACT.containerId} table, #${CONTRACT.containerId} thead, #${CONTRACT.containerId} tbody, #${CONTRACT.containerId} tr, #${CONTRACT.containerId} th, #${CONTRACT.containerId} td { display: block; }
              #${CONTRACT.containerId} thead { display: none; }
              #${CONTRACT.containerId} td { padding-left: 0; padding-right: 0; }
            }
          </style>

          <div class="mc-grid">
            <div class="mc-card">
              <h3>Primary Registrant</h3>
              <div class="mc-grid two">
                <div class="mc-field">
                  <label for="mc-primary-attendance">Attendance Type</label>
                  <select id="mc-primary-attendance" data-mc-input="primary.attendance_type">
                    ${buildSelectOptions(state.primaryExtras.attendance_type, ATTENDANCE_OPTIONS.map((option) => ({ value: option.key, label: option.label })))}
                  </select>
                </div>
                <div class="mc-field">
                  <label for="mc-primary-program">Program</label>
                  <select id="mc-primary-program" data-mc-input="primary.program">
                    ${buildSelectOptions(state.primaryExtras.program, [
                      { value: PROGRAMS.standard.key, label: PROGRAMS.standard.label },
                      { value: PROGRAMS.young_mens.key, label: PROGRAMS.young_mens.label }
                    ])}
                  </select>
                  <div class="mc-inline-error">${escapeHtml(primaryProgramError)}</div>
                </div>
                <div class="mc-field">
                  <label for="mc-primary-shirt">Shirt Size</label>
                  <select id="mc-primary-shirt" data-mc-input="primary.shirt">
                    ${buildSelectOptions(state.primaryExtras.shirt, [{ value: '', label: 'Select size' }].concat(SHIRT_SIZES.map((size) => ({
                      value: size,
                      label: primaryShirts[size].label,
                      disabled: primaryShirts[size].disabled && state.primaryExtras.shirt !== size
                    }))))}
                  </select>
                  <div class="mc-inline-error">${escapeHtml(state.primaryErrors.shirt || '')}</div>
                </div>
                <div class="mc-field">
                  <label for="mc-primary-volunteer">Volunteer</label>
                  <select id="mc-primary-volunteer" data-mc-input="primary.volunteer">
                    ${buildSelectOptions(state.primaryExtras.volunteer, [
                      { value: 'no', label: 'No' },
                      { value: 'yes', label: 'Yes' }
                    ])}
                  </select>
                </div>
                ${showPrimaryGuardian ? `
                  <div class="mc-field">
                    <label for="mc-primary-guardian">Guardian</label>
                    <select id="mc-primary-guardian" data-mc-input="primary.guardianIndex">
                      ${buildSelectOptions(
                        Number.isInteger(state.primaryExtras.guardianIndex) ? String(state.primaryExtras.guardianIndex) : '',
                        primaryGuardianOptions
                      )}
                    </select>
                    <div class="mc-inline-warning">${escapeHtml(!adultsForPrimary.length ? 'A guardian must be added before registering a child.' : '')}</div>
                    <div class="mc-inline-error">${escapeHtml(state.primaryErrors.guardian || '')}</div>
                  </div>
                ` : ''}
              </div>
            </div>

            <div class="mc-card">
              <h3>Lodging</h3>
              <div class="mc-lodging-options">
                ${LODGING_OPTIONS.map((option) => `
                  <label class="mc-option">
                    <input type="radio" name="mc-lodging-option" value="${escapeHtml(option.key)}"${state.lodging.type === option.key ? ' checked' : ''}>
                    <span>
                      <strong>${escapeHtml(option.label)}</strong>
                      <span>$${formatMoney(option.price)} per overnight attendee</span>
                    </span>
                  </label>
                `).join('')}
              </div>
              ${state.lodging.type === 'rv_hookups' ? `
                <div class="mc-grid two" style="margin-top:14px;">
                  <div class="mc-field">
                    <label for="mc-rv-amp">RV Amp</label>
                    <select id="mc-rv-amp" data-mc-input="lodging.rvAmp">
                      ${buildSelectOptions(state.lodging.rvAmp, [
                        { value: '', label: 'Select amp service' },
                        { value: '30', label: '30 Amp' },
                        { value: '50', label: '50 Amp' }
                      ])}
                    </select>
                  </div>
                  <div class="mc-field">
                    <label for="mc-rv-length">RV Length (feet)</label>
                    <input id="mc-rv-length" type="number" min="1" step="1" value="${escapeHtml(state.lodging.rvLengthFeet)}" data-mc-input="lodging.rvLengthFeet">
                  </div>
                </div>
              ` : ''}
            </div>

            <div class="mc-card">
              <h3>Add Additional Attendee</h3>
              <div class="mc-grid two">
                <div class="mc-field">
                  <label for="mc-draft-first-name">First Name</label>
                  <input id="mc-draft-first-name" type="text" value="${escapeHtml(state.draft.first_name)}" data-mc-input="draft.first_name">
                  <div class="mc-inline-error">${escapeHtml(state.draftErrors.first_name || '')}</div>
                </div>
                <div class="mc-field">
                  <label for="mc-draft-last-name">Last Name</label>
                  <input id="mc-draft-last-name" type="text" value="${escapeHtml(state.draft.last_name)}" data-mc-input="draft.last_name">
                  <div class="mc-inline-error">${escapeHtml(state.draftErrors.last_name || '')}</div>
                </div>
                <div class="mc-field">
                  <label for="mc-draft-age">Age</label>
                  <input id="mc-draft-age" type="number" min="0" step="1" value="${escapeHtml(state.draft.age)}" data-mc-input="draft.age">
                  <div class="mc-inline-error">${escapeHtml(state.draftErrors.age || '')}</div>
                </div>
                <div class="mc-field">
                  <label for="mc-draft-attendance">Attendance Type</label>
                  <select id="mc-draft-attendance" data-mc-input="draft.attendance_type">
                    ${buildSelectOptions(state.draft.attendance_type, ATTENDANCE_OPTIONS.map((option) => ({ value: option.key, label: option.label })))}
                  </select>
                </div>
                <div class="mc-field">
                  <label for="mc-draft-program">Program</label>
                  <select id="mc-draft-program" data-mc-input="draft.program">
                    ${buildSelectOptions(state.draft.program, [
                      { value: PROGRAMS.standard.key, label: PROGRAMS.standard.label },
                      { value: PROGRAMS.young_mens.key, label: PROGRAMS.young_mens.label }
                    ])}
                  </select>
                  <div class="mc-inline-error">${escapeHtml(state.draftErrors.program || '')}</div>
                </div>
                <div class="mc-field">
                  <label for="mc-draft-shirt">Shirt Size</label>
                  <select id="mc-draft-shirt" data-mc-input="draft.shirt">
                    ${buildSelectOptions(state.draft.shirt, [{ value: '', label: 'Select size' }].concat(SHIRT_SIZES.map((size) => ({
                      value: size,
                      label: draftShirts[size].label,
                      disabled: draftShirts[size].disabled && state.draft.shirt !== size
                    }))))}
                  </select>
                  <div class="mc-inline-error">${escapeHtml(state.draftErrors.shirt || '')}</div>
                </div>
                <div class="mc-field">
                  <label for="mc-draft-volunteer">Volunteer</label>
                  <select id="mc-draft-volunteer" data-mc-input="draft.volunteer">
                    ${buildSelectOptions(state.draft.volunteer, [
                      { value: 'no', label: 'No' },
                      { value: 'yes', label: 'Yes' }
                    ])}
                  </select>
                </div>
                ${showDraftGuardian ? `
                  <div class="mc-field">
                    <label for="mc-draft-guardian">Guardian</label>
                    <select id="mc-draft-guardian" data-mc-input="draft.guardianIndex">
                      ${buildSelectOptions(
                        Number.isInteger(state.draft.guardianIndex) ? String(state.draft.guardianIndex) : '',
                        draftGuardianOptions
                      )}
                    </select>
                    <div class="mc-inline-warning">${escapeHtml(!adultsForDraft.length ? 'A guardian must be added before registering a child.' : '')}</div>
                    <div class="mc-inline-error">${escapeHtml(state.draftErrors.guardian || '')}</div>
                  </div>
                ` : ''}
              </div>
              <div class="mc-actions" style="margin-top:12px;">
                <button type="button" class="mc-primary-button" data-mc-action="add-attendee">Add Attendee</button>
              </div>
            </div>

            <div class="mc-card">
              <h3>Attendee Roster</h3>
              <div class="mc-inline-error">${escapeHtml(state.rosterError || '')}</div>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Age</th>
                    <th>Program</th>
                    <th>Attendance</th>
                    <th>Shirt</th>
                    <th>Guardian</th>
                    <th>Volunteer</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${people.map((person, index) => `
                    <tr>
                      <td>
                        <strong>${escapeHtml(`${person.first_name} ${person.last_name}`.trim())}</strong>
                        ${person.is_primary ? '<div class="mc-pill">Primary</div>' : ''}
                        ${person._warnings.length ? `<div class="mc-warning-list">${person._warnings.map((warning) => `<div>${escapeHtml(warning)}</div>`).join('')}</div>` : ''}
                      </td>
                      <td>${escapeHtml(person.age == null ? '' : person.age)}</td>
                      <td>${escapeHtml(person.program === PROGRAMS.young_mens.key ? PROGRAMS.young_mens.label : PROGRAMS.standard.label)}</td>
                      <td>${escapeHtml(person.attendance_type === 'sabbath_only' ? 'Sabbath Only' : 'Overnight')}</td>
                      <td>${escapeHtml(person.shirt)}</td>
                      <td>
                        ${person.age_group === 'child'
                          ? `<select data-mc-existing-guardian="${index}">
                              ${buildSelectOptions(
                                Number.isInteger((rawPeople[index] || {}).guardianIndex) ? String(rawPeople[index].guardianIndex) : '',
                                [{ value: '', label: 'Select guardian' }].concat(
                                  adultsForGuardians(rawPeople, index).map(({ person: guardianPerson, index: guardianIndex }) => ({
                                    value: String(guardianIndex),
                                    label: `${guardianPerson.first_name} ${guardianPerson.last_name}`.trim()
                                  }))
                                )
                              )}
                            </select>`
                          : escapeHtml(person.is_guardian ? 'Guardian' : '')
                        }
                      </td>
                      <td>${escapeHtml(person.volunteer === 'yes' ? 'Yes' : 'No')}</td>
                      <td>${index === 0 ? '' : '<button type="button" class="mc-secondary-button" data-mc-action="remove-attendee" data-index="' + (index - 1) + '">Remove</button>'}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <div class="mc-summary">
              <h3 style="color:#fff;">Summary</h3>
              <div>${people.length} attendee${people.length === 1 ? '' : 's'}</div>
              <div class="muted" style="margin-top:6px;">${totals.overnightCount} overnight @ $${formatMoney(totals.overnightPrice)} + ${totals.sabbathOnlyCount} sabbath-only @ $${formatMoney(SABBATH_ONLY_PRICE)} = $${formatMoney(totals.baseTotal)}</div>
              <div class="muted" style="margin-top:6px;">Processing fee: $${formatMoney(totals.processingFee)} (${state.paymentMethod === 'offline' ? 'offline payment' : 'Square'})</div>
              <div style="margin-top:10px; font-size: 20px; font-weight: 700;">Total due: $${formatMoney(totals.customPaymentAmount)}</div>
              <div class="muted" style="margin-top:6px;">Lodging option: ${escapeHtml(lodgingOption.label)}</div>
              ${state.availabilityWarning ? `<div class="mc-inline-warning" style="margin-top:8px;color:#ffd8a8;">${escapeHtml(state.availabilityWarning)}</div>` : ''}
            </div>
          </div>
        </div>
      `;

      injectExternalError(primaryFields.first_name, state.externalErrors.first_name || '', 'first_name');
      injectExternalError(primaryFields.last_name, state.externalErrors.last_name || '', 'last_name');
      injectExternalError(primaryFields.age, state.externalErrors.age || '', 'age');

      bindInternalEvents();
    }

    function bindInternalEvents() {
      container.querySelectorAll('[data-mc-input]').forEach((element) => {
        element.addEventListener('input', handleInternalInput);
        element.addEventListener('change', handleInternalInput);
      });

      container.querySelectorAll('input[name="mc-lodging-option"]').forEach((element) => {
        element.addEventListener('change', () => {
          state.lodging.type = canonicalLodgingKey(element.value);
          render();
        });
      });

      const addButton = container.querySelector('[data-mc-action="add-attendee"]');
      if (addButton) {
        addButton.addEventListener('click', async () => {
          state.rosterError = '';
          if (!validateDraft()) {
            render();
            return;
          }

          const people = allPeopleRaw();
          const age = parseAge(state.draft.age);
          const nextPerson = Object.assign({}, state.draft, {
            age: age === null ? '' : age,
            guardianIndex: age !== null && age < 18
              ? (Number.isInteger(state.draft.guardianIndex) ? state.draft.guardianIndex : defaultGuardianIndexForChild(people))
              : null
          });

          state.additionalPeople.push(nextPerson);
          state.draft = {
            first_name: '',
            last_name: '',
            age: '',
            attendance_type: 'overnight',
            program: PROGRAMS.standard.key,
            shirt: '',
            volunteer: 'no',
            guardianIndex: null
          };
          state.draftErrors = {};
          render();
          await refreshAvailability();
        });
      }

      container.querySelectorAll('[data-mc-action="remove-attendee"]').forEach((button) => {
        button.addEventListener('click', async () => {
          const removalIndex = Number(button.getAttribute('data-index'));
          if (!Number.isInteger(removalIndex) || removalIndex < 0 || removalIndex >= state.additionalPeople.length) return;

          const globalIndex = removalIndex + 1;
          state.additionalPeople.splice(removalIndex, 1);

          const remapPerson = (person, personIndex) => {
            if (!Number.isInteger(person.guardianIndex)) return person;
            if (person.guardianIndex === globalIndex) {
              person.guardianIndex = null;
              person._guardianResetWarning = 'Guardian removed. Please select a new guardian.';
            } else if (person.guardianIndex > globalIndex) {
              person.guardianIndex -= 1;
            }
            if (personIndex === 0 && person.guardianIndex === 0) {
              person.guardianIndex = null;
            }
            return person;
          };

          state.primaryExtras = remapPerson(state.primaryExtras, 0);
          state.additionalPeople = state.additionalPeople.map((person, index) => remapPerson(person, index + 1));
          render();
          await refreshAvailability();
        });
      });

      container.querySelectorAll('[data-mc-existing-guardian]').forEach((select) => {
        select.addEventListener('change', () => {
          const index = Number(select.getAttribute('data-mc-existing-guardian'));
          const value = select.value === '' ? null : Number(select.value);
          if (index === 0) {
            state.primaryExtras.guardianIndex = value;
            delete state.primaryExtras._guardianResetWarning;
          } else if (state.additionalPeople[index - 1]) {
            state.additionalPeople[index - 1].guardianIndex = value;
            delete state.additionalPeople[index - 1]._guardianResetWarning;
          }
          render();
        });
      });
    }

    function handleInternalInput(event) {
      const target = event.currentTarget;
      const key = target.getAttribute('data-mc-input');
      if (!key) return;

      const value = target.type === 'checkbox' ? (target.checked ? 'yes' : 'no') : target.value;
      if (key.indexOf('primary.') === 0) {
        const field = key.replace('primary.', '');
        state.primaryExtras[field] = field === 'guardianIndex' && value !== '' ? Number(value) : value;
        if (field === 'guardianIndex' && value !== '') {
          delete state.primaryExtras._guardianResetWarning;
        }
        if (field === 'program') {
          state.primaryErrors.program = '';
        }
      } else if (key.indexOf('draft.') === 0) {
        const field = key.replace('draft.', '');
        state.draft[field] = field === 'guardianIndex' && value !== '' ? Number(value) : value;
        if (field === 'age') {
          const parsedAge = parseAge(value);
          if (parsedAge !== null && parsedAge < 18 && !Number.isInteger(state.draft.guardianIndex)) {
            state.draft.guardianIndex = defaultGuardianIndexForChild(allPeopleRaw());
          }
        }
      } else if (key.indexOf('lodging.') === 0) {
        const field = key.replace('lodging.', '');
        state.lodging[field] = value;
      }
      render();
    }

    async function refreshAvailability() {
      if (!state.gasUrl) return;
      try {
        const url = new URL(state.gasUrl, window.location.href);
        url.searchParams.set('action', 'getAvailability');
        const response = await fetch(url.toString(), { method: 'GET', credentials: 'omit' });
        if (!response.ok) throw new Error(`Availability request failed with ${response.status}`);
        const data = await response.json();
        state.shirtInventory = data && data.shirts ? data.shirts : null;
        state.availabilityWarning = '';
        render();
      } catch (error) {
        state.shirtInventory = null;
        state.availabilityWarning = '';
        window.console.warn('Man Camp shirt availability fetch failed; leaving all sizes enabled.', error);
        render();
      }
    }

    function handleFormSubmit(event) {
      state.rosterError = '';
      const primaryValid = validatePrimary();
      const people = serializePeople();
      const invalidGuardian = people.some((person) => person.age_group === 'child' && !person.guardian_link_key);

      if (invalidGuardian) {
        state.rosterError = 'Each child attendee must have a guardian before submitting.';
      }

      if (!primaryValid || invalidGuardian) {
        event.preventDefault();
        render();
        return;
      }

      syncHiddenFields();
    }

    Object.values(primaryFields).forEach((field) => {
      if (!field) return;
      field.addEventListener('input', () => {
        if (field === primaryFields.age) {
          const primaryAge = parseAge(field.value);
          if (primaryAge !== null && primaryAge < 18 && !Number.isInteger(state.primaryExtras.guardianIndex)) {
            state.primaryExtras.guardianIndex = defaultGuardianIndexForChild(allPeopleRaw());
          }
        }
        validatePrimary();
        render();
      });
      field.addEventListener('change', () => {
        validatePrimary();
        render();
      });
    });

    const paymentControl = findPaymentMethodControl(form);
    if (paymentControl) {
      form.addEventListener('change', (event) => {
        const target = event.target;
        if (!target) return;
        if (target.name === 'payment_method' || target.closest('[data-payment-method]')) {
          render();
        }
      });
    }

    form.addEventListener('submit', handleFormSubmit, true);

    container.dataset.mcInitialized = 'true';
    container.setAttribute('data-mancamp-builder-ready', 'true');
    container.classList.add('mancamp-builder-host');

    validatePrimary();
    render();
    refreshAvailability();
  }

  function getField(form, name) {
    return form.querySelector(`[name="${name}"], [data-name="${name}"]`);
  }

  function readFieldValue(form, name) {
    const field = getField(form, name);
    if (!field) return '';
    if (field.matches('input[type="radio"]')) {
      const checked = form.querySelector(`[name="${name}"]:checked`);
      return checked ? checked.value : '';
    }
    return field.value || '';
  }

  function setFieldValue(form, name, value) {
    const field = getField(form, name);
    if (!field) return false;
    if (field.value === value) return true;
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function applyNoTranslate() {
    const container = document.getElementById(CONTRACT.containerId);
    if (!container) return;
    const form = container.closest('form') || document.querySelector('form');
    if (!form) return;

    [
      CONTRACT.peopleField,
      'attendees_json',
      CONTRACT.rosterField,
      CONTRACT.lodgingRequestField,
      CONTRACT.registrationTotalField,
      CONTRACT.processingFeeField,
      CONTRACT.paymentMethodField,
      CONTRACT.payTypeField
    ].concat(CONTRACT.customPaymentAmountFields).forEach((name) => {
      noTranslateField(getField(form, name));
    });
  }

  function tryInit(attempt) {
    const container = document.getElementById(CONTRACT.containerId);
    if (!container) {
      if (attempt < RETRY_LIMIT) {
        window.setTimeout(() => tryInit(attempt + 1), RETRY_DELAY_MS);
      }
      return;
    }

    if (container.dataset.mcInitialized === 'true') {
      applyNoTranslate();
      return;
    }

    const form = container.closest('form') || document.querySelector('form');
    if (!form) {
      if (attempt < RETRY_LIMIT) {
        window.setTimeout(() => tryInit(attempt + 1), RETRY_DELAY_MS);
      }
      return;
    }

    initWidget(container, form);
    applyNoTranslate();
  }

  window.ManCampFormBridge = {
    contract: CONTRACT,
    getField,
    setFieldValue
  };

  document.addEventListener('DOMContentLoaded', () => tryInit(0));
  document.addEventListener('fluentform_step_changed', () => {
    applyNoTranslate();
    tryInit(0);
  });
})();
