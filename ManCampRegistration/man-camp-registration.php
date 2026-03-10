<?php
/**
 * Plugin Name: Man Camp Registration
 * Plugin URI:  https://imsda.org
 * Description: Bridges Fluent Forms Man Camp registration submissions to the
 *              Google Apps Script backend and provides the Man Camp attendee widget.
 * Version:     2.1.0
 * Author:      Iowa-Missouri Conference of Seventh-day Adventists
 * Author URI:  https://imsda.org
 * License:     GPL-2.0+
 * Text Domain: man-camp-registration
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

// ============================================================
// SECTION 1 — SETTINGS HELPERS
// ============================================================

define( 'MANCAMP_OPTION_GROUP', 'mancamp_settings' );
define( 'MANCAMP_HTTP_TIMEOUT', 30 );
define( 'MANCAMP_EVENT_KEY', 'man-camp-2026' );
define( 'MANCAMP_FAILED_WEBHOOKS_OPTION', 'mancamp_failed_webhooks' );
define( 'MANCAMP_SENT_ENTRY_IDS_OPTION', 'mancamp_sent_entry_ids' );
define( 'MANCAMP_WEBHOOK_LOG_OPTION', 'mancamp_webhook_log' );
define( 'MANCAMP_RETRY_HOOK', 'mancamp_retry_webhooks' );
define( 'MANCAMP_OFFLINE_SWEEP_HOOK', 'mancamp_offline_sweep' );
define( 'MANCAMP_OFFLINE_SWEEP_STATUS_OPTION', 'mancamp_offline_sweep_status' );

function mancamp_get_setting( $key, $default = '' ) {
    $options = get_option( MANCAMP_OPTION_GROUP, [] );
    return isset( $options[ $key ] ) ? $options[ $key ] : $default;
}

function mancamp_gas_url()       { return mancamp_get_setting( 'gas_url',       '' ); }
function mancamp_form_id()       { return (int) mancamp_get_setting( 'form_id',      0 ); }
function mancamp_page_slug()     { return mancamp_get_setting( 'page_slug',     'man-camp-registration' ); }
function mancamp_debug()         { return (bool) mancamp_get_setting( 'debug_mode',  false ); }
function mancamp_offline_values() {
    $raw = mancamp_get_setting( 'offline_values', '' );
    if ( empty( $raw ) ) return [ 'offline', 'check', 'cash' ];
    return array_values( array_filter( array_map( 'trim', explode( ',', strtolower( $raw ) ) ) ) );
}


// ============================================================
// SECTION 2 — FIELD MAP
// ============================================================

const MANCAMP_FIELD_MAP = [
    'first_name'              => 'first_name',
    'last_name'               => 'last_name',
    'email'                   => 'email',
    'phone'                   => 'phone',
    'age'                     => 'age',
    'age_group'               => 'age_group',
    'is_minor'                => 'is_minor',
    'is_guardian'             => 'is_guardian',
    'program_type'            => 'program_type',
    'shirt_size'              => 'shirt_size',
    'lodging_option_key'      => 'lodging_option_key',
    'lodging_option_label'    => 'lodging_option_label',
    'lodging_request_json'    => 'lodging_request_json',
    'attendance_type'         => 'attendance_type',
    'rv_amp'                  => 'rv_amp',
    'rv_length'               => 'rv_length',
    'people_json'             => 'people_json',
    'attendees_json'          => 'attendees_json',
    'roster_json'             => 'roster_json',
    'attendee_count'          => 'attendee_count',
    'registration_total'      => 'registration_total',
    'processing_fee'          => 'processing_fee',
    'payment_method'          => 'payment_method',
    'notes'                   => 'notes',
    'medical_notes'           => 'medical_notes',
];

const MANCAMP_BOOLEAN_FIELDS = [
    'is_minor',
    'is_guardian',
];

const MANCAMP_VALID_AGE_GROUPS = [
    'adult',
    'child',
];

const MANCAMP_VALID_LODGING_PREFERENCES = [
    'shared_cabin_connected',
    'shared_cabin_detached',
    'rv_hookups',
    'tent_no_hookups',
    'sabbath_attendance_only',
];

const MANCAMP_VALID_LODGING_STATUSES = [
    'assigned',
    'waitlist',
    'pending',
    'manual_review',
];

const MANCAMP_VALID_BUNK_TYPES = [
    'bottom',
    'top_guardian_child',
    'rv',
    'tent',
    'day_only',
    'none',
];


// ============================================================
// SECTION 3 — HOOKS
// ============================================================

add_action( 'plugins_loaded', 'mancamp_register_hooks' );

function mancamp_register_hooks() {
    add_action( 'wp_enqueue_scripts', 'mancamp_enqueue_scripts' );
    add_action( 'wp_head',            'mancamp_add_notranslate_meta' );
    add_action( 'admin_menu',         'mancamp_admin_menu' );
    add_action( 'admin_notices',      'mancamp_admin_notice_for_stale_failures' );
    add_action( 'admin_post_mancamp_save_settings',  'mancamp_save_settings' );
    add_action( 'admin_post_mancamp_retry',          'mancamp_handle_retry' );
    add_action( 'admin_post_mancamp_manual_resync',  'mancamp_handle_manual_resync' );
    add_action( 'admin_post_mancamp_run_offline_sweep', 'mancamp_handle_run_offline_sweep' );
    add_action( 'fluentform_payment_paid', 'mancamp_handle_payment_event', 20, 10 );
    add_action( 'fluentform_payment_status_to_paid', 'mancamp_handle_payment_event', 20, 10 );
    add_action( 'fluentform_payment_status_updated', 'mancamp_maybe_send_offline', 10, 3 );
    add_action( 'fluentform_submission_inserted', 'mancamp_maybe_send_offline_on_submit', 10, 3 );
    add_action( MANCAMP_RETRY_HOOK, 'mancamp_retry_failed_webhooks' );
    add_action( MANCAMP_OFFLINE_SWEEP_HOOK, 'mancamp_sweep_offline_submissions' );
    add_filter( 'cron_schedules', 'mancamp_add_cron_schedule' );
    mancamp_schedule_retry_event();
    mancamp_schedule_offline_sweep_event();
}


// ============================================================
// SECTION 4 — SCRIPT ENQUEUE
// ============================================================

function mancamp_enqueue_scripts() {
    if ( ! mancamp_is_registration_page() ) return;

    $js_file = plugin_dir_path( __FILE__ ) . 'man-camp-registration.js';
    $version = file_exists( $js_file ) ? filemtime( $js_file ) : '2.0.0';

    wp_enqueue_script(
        'man-camp-registration',
        plugin_dir_url( __FILE__ ) . 'man-camp-registration.js',
        [],
        $version,
        true
    );

    wp_localize_script( 'man-camp-registration', 'manCampRegistrationSettings', [
        'gasUrl'        => mancamp_gas_url(),
        'offlineValues' => mancamp_offline_values(),
        'fieldContract' => [
            'containerId' => 'mancamp-builder',
            'peopleField' => 'people_json',
            'rosterField' => 'roster_json',
            'attendeeCountField' => 'attendee_count',
            'payTypeField' => 'pay_type',
            'paymentMethodField' => 'payment_method',
            'lodgingOptionKeyField' => 'lodging_option_key',
            'lodgingOptionLabelField' => 'lodging_option_label',
            'lodgingRequestField' => 'lodging_request_json',
            'rvAmpField' => 'rv_amp',
            'rvLengthField' => 'rv_length',
            'registrationTotalField' => 'registration_total',
            'processingFeeField' => 'processing_fee',
            'customPaymentAmountFields' => [ 'custom_payment_amount', 'custom-payment-amount' ],
        ],
    ] );
}

function mancamp_is_registration_page() {
    $slug = mancamp_page_slug();
    if ( empty( $slug ) ) return false;
    if ( is_page( $slug ) ) return true;
    $request_uri = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : '';
    $current = trim( (string) wp_parse_url( $request_uri, PHP_URL_PATH ), '/' );
    if ( $current === '' ) return false;

    $segments = array_values( array_filter( explode( '/', $current ) ) );
    return ! empty( $segments ) && end( $segments ) === $slug;
}


// ============================================================
// SECTION 5 — NOTRANSLATE META TAG
// ============================================================

function mancamp_add_notranslate_meta() {
    if ( ! mancamp_is_registration_page() ) return;
    // Protect hidden JSON fields from translation, not the whole page.
    ?>
    <script>
    document.addEventListener('DOMContentLoaded', function () {
        const selector = [
          'input[name="people_json"]',
          'input[data-name="people_json"]',
          'input[name="attendees_json"]',
          'input[data-name="attendees_json"]',
          'input[name="roster_json"]',
          'input[data-name="roster_json"]',
          'input[name="lodging_request_json"]',
          'input[data-name="lodging_request_json"]',
          'input[name="custom_payment_amount"]',
          'input[data-name="custom_payment_amount"]',
          'input[name="custom-payment-amount"]',
          'input[data-name="custom-payment-amount"]'
        ].join(', ');
        const applyNoTranslate = () => {
            document.querySelectorAll(selector).forEach((field) => {
                field.setAttribute('translate', 'no');
                field.classList.add('notranslate');
            });
        };
        applyNoTranslate(); // Run on load
        document.addEventListener('fluentform_step_changed', applyNoTranslate);
    });
    </script>
    <?php
}


// ============================================================
// SECTION 6 — PAYMENT WEBHOOK PIPELINE
// ============================================================

function mancamp_handle_payment_event( ...$args ) {
    $context = mancamp_resolve_payment_hook_context( $args );
    if ( is_wp_error( $context ) ) {
        mancamp_log_event( 0, 'failed', 'Payment hook context error: ' . $context->get_error_message() );
        return;
    }

    $entry_id = (int) $context['entry_id'];
    $form_id = (int) $context['form_id'];

    if ( $form_id !== mancamp_form_id() ) {
        return;
    }

    mancamp_process_entry_webhook( $entry_id, [
        'submission' => $context['submission'],
        'payment'    => $context['payment'],
    ], false, 'paid_hook', 'Paid hook attempting webhook delivery.' );
}

function mancamp_maybe_send_offline( $newStatus, $entryId, $submission ) {
    $entry_id = (int) $entryId;
    if ( $entry_id <= 0 || mancamp_has_sent_entry_id( $entry_id ) ) {
        if ( $entry_id > 0 && mancamp_has_sent_entry_id( $entry_id ) ) {
            mancamp_log_event( $entry_id, 'duplicate', 'Skipping offline status hook because this entry_id was already sent.' );
        }
        return;
    }

    $status = strtolower( sanitize_text_field( (string) $newStatus ) );
    if ( ! in_array( $status, [ 'pending', 'processing', 'paid', 'completed', 'partially-paid' ], true ) ) {
        return;
    }

    $submission_record = mancamp_normalise_submission_argument( $submission, $entry_id );
    if ( is_wp_error( $submission_record ) ) {
        mancamp_log_event( $entry_id, 'failed', 'Offline status hook could not load submission: ' . $submission_record->get_error_message() );
        return;
    }

    if ( (int) ( $submission_record['form_id'] ?? 0 ) !== mancamp_form_id() ) {
        return;
    }

    $payment = mancamp_get_payment_record( $entry_id );
    if ( ! mancamp_is_offline_submission( $submission_record, $payment ) ) {
        return;
    }

    mancamp_process_entry_webhook( $entry_id, [
        'submission' => $submission_record,
        'payment'    => $payment,
    ], false, 'offline_status_hook', 'Offline status hook attempting webhook delivery.' );
}

function mancamp_maybe_send_offline_on_submit( $insertId, $formData, $form ) {
    $entry_id = (int) $insertId;
    if ( $entry_id <= 0 ) {
        return;
    }

    if ( mancamp_has_sent_entry_id( $entry_id ) ) {
        mancamp_log_event( $entry_id, 'duplicate', 'Skipping offline submission hook because this entry_id was already sent.' );
        return;
    }

    if ( (int) ( $form->id ?? 0 ) !== mancamp_form_id() ) {
        return;
    }

    $submission = [
        'id'         => $entry_id,
        'form_id'    => (int) ( $form->id ?? 0 ),
        'response'   => is_array( $formData ) ? $formData : [],
        'created_at' => current_time( 'mysql' ),
    ];

    if ( ! mancamp_is_offline_submission( $submission ) ) {
        return;
    }

    sleep( 3 );

    mancamp_process_entry_webhook( $entry_id, [
        'submission' => $submission,
        'payment'    => mancamp_get_payment_record( $entry_id ),
    ], false, 'offline_submission_hook', 'Offline submission hook attempting webhook delivery.' );
}

function mancamp_process_entry_webhook( $entry_id, $context = [], $is_retry = false, $attempt_status = 'attempting', $attempt_message = '' ) {
    $entry_id = (int) $entry_id;
    if ( $entry_id <= 0 ) {
        return new WP_Error( 'missing_entry_id', 'Missing Fluent Forms entry ID.' );
    }

    mancamp_prune_sent_entry_ids();

    if ( mancamp_has_sent_entry_id( $entry_id ) ) {
        mancamp_log_event( $entry_id, 'duplicate', 'Skipping webhook because this entry_id was already sent.' );
        return [ 'duplicate' => true ];
    }

    $submission = ! empty( $context['submission'] ) ? $context['submission'] : mancamp_get_submission_record( $entry_id );
    if ( is_wp_error( $submission ) ) {
        mancamp_log_event( $entry_id, 'failed', 'Submission lookup failed: ' . $submission->get_error_message() );
        return $submission;
    }

    if ( (int) ( $submission['form_id'] ?? 0 ) !== mancamp_form_id() ) {
        return new WP_Error( 'wrong_form', 'Submission does not belong to the configured Fluent Form.' );
    }

    $payment = ! empty( $context['payment'] ) ? $context['payment'] : mancamp_get_payment_record( $entry_id );
    $payload = mancamp_build_payload( $submission, $payment );

    if ( is_wp_error( $payload ) ) {
        mancamp_log_event( $entry_id, 'failed', 'Payload build error: ' . $payload->get_error_message() );
        return $payload;
    }

    $log_status = $is_retry ? 'retry' : $attempt_status;
    $log_message = $is_retry
        ? 'Retrying webhook POST to GAS.'
        : ( $attempt_message !== '' ? $attempt_message : 'Attempting webhook POST to GAS.' );

    mancamp_log_event( $entry_id, $log_status, $log_message );
    $result = mancamp_post_to_gas( $payload );

    if ( is_wp_error( $result ) ) {
        mancamp_store_failed_payload( $entry_id, $payload, $result->get_error_message(), $is_retry );
        mancamp_log_event( $entry_id, 'failed', 'Webhook POST failed: ' . $result->get_error_message() );
        return $result;
    }

    mancamp_mark_entry_sent( $entry_id );
    mancamp_remove_failed_payload( $entry_id );
    mancamp_log_event( $entry_id, 'success', 'Webhook delivered to GAS successfully.' );

    return $result;
}


// ============================================================
// SECTION 7 — PAYLOAD BUILDER
// ============================================================

function mancamp_build_payload( $submission, $payment = [] ) {
    $form_data = is_array( $submission['response'] ?? null ) ? $submission['response'] : [];
    $top_level = mancamp_extract_top_level_fields( $form_data );
    $entry_id = (int) ( $submission['id'] ?? 0 );

    $people = mancamp_extract_people_payload( $form_data );
    if ( is_wp_error( $people ) ) {
        return $people;
    }

    $primary = $people[0];
    $lodging_request = mancamp_extract_lodging_request( $form_data, $primary );
    $payment_meta = mancamp_collect_payment_meta( $form_data, $payment, $top_level );
    $attendee_count = mancamp_resolve_attendee_count( $top_level, $people );
    $submitted_at = mancamp_submission_timestamp( $submission );
    mancamp_warn_for_missing_fields( $entry_id, $top_level );

    return [
        'action'            => 'submitRegistration',
        'eventKey'          => MANCAMP_EVENT_KEY,
        'fluentFormEntryId' => (string) $entry_id,
        'submittedAt'       => $submitted_at,
        'primaryContact'    => [
            'name'  => trim( $primary['first_name'] . ' ' . $primary['last_name'] ),
            'email' => $primary['email'],
            'phone' => $primary['phone'],
        ],
        'lodgingRequest'    => $lodging_request,
        'people'            => $people,
        'attendeeCount'     => $attendee_count,
        'payment'           => $payment_meta,
    ];
}

function mancamp_extract_top_level_fields( $form_data ) {
    $top_level = [];

    foreach ( MANCAMP_FIELD_MAP as $ff_key => $gas_key ) {
        if ( ! isset( $form_data[ $ff_key ] ) ) {
            continue;
        }

        $top_level[ $gas_key ] = mancamp_sanitise_top_level_field( $ff_key, $form_data[ $ff_key ] );
    }

    if ( ! isset( $top_level['payment_method'] ) ) {
        $top_level['payment_method'] = mancamp_normalise_pay_type( mancamp_pick_field( $form_data, [ 'mc_payment_method_out', 'payment_method', 'pay_type' ], 'square' ) );
    }

    if ( ! isset( $top_level['people_json'] ) ) {
        $top_level['people_json'] = mancamp_pick_field( $form_data, [ 'people_json', 'attendees_json' ], '' );
    }

    if ( ! isset( $top_level['roster_json'] ) ) {
        $top_level['roster_json'] = mancamp_pick_field( $form_data, [ 'roster_json', 'people_json', 'attendees_json' ], '' );
    }

    if ( ! isset( $top_level['attendees_json'] ) ) {
        $top_level['attendees_json'] = mancamp_pick_field( $form_data, [ 'attendees_json', 'people_json' ], '' );
    }

    return $top_level;
}


// ============================================================
// SECTION 8 — ATTENDEE SANITISERS
// ============================================================

function mancamp_extract_people_payload( $formData ) {
    $people_raw = mancamp_pick_field( $formData, [ 'people_json', 'attendees_json', 'roster_json' ], '' );

    if ( $people_raw !== '' ) {
        $decoded = json_decode( wp_unslash( $people_raw ), true );
        if ( json_last_error() !== JSON_ERROR_NONE || ! is_array( $decoded ) ) {
            return new WP_Error( 'invalid_people_json', 'Could not decode people_json: ' . json_last_error_msg() );
        }

        return mancamp_sanitise_people( $decoded, $formData );
    }

    $fallback_person = mancamp_build_single_person_from_fields( $formData );
    if ( empty( $fallback_person ) ) {
        return new WP_Error( 'empty_people', 'No attendee data was submitted.' );
    }

    return [ $fallback_person ];
}

function mancamp_sanitise_people( $people, $formData = [] ) {
    $clean = [];
    $default_option_key = mancamp_normalise_lodging_preference( $formData['lodging_option_key'] ?? '' );
    $default_program = sanitize_text_field( $formData['program_type'] ?? $formData['program'] ?? 'standard' );
    $default_shirt = strtoupper( sanitize_text_field( $formData['shirt_size'] ?? '' ) );

    foreach ( $people as $idx => $raw ) {
        if ( ! is_array( $raw ) ) {
            continue;
        }

        $age = is_numeric( $raw['age'] ?? null ) ? (int) $raw['age'] : ( is_numeric( $formData['age'] ?? $formData['ageNum'] ?? null ) ? (int) ( $formData['age'] ?? $formData['ageNum'] ) : '' );
        $first_name = sanitize_text_field( $raw['first_name'] ?? $raw['firstName'] ?? '' );
        $last_name  = sanitize_text_field( $raw['last_name'] ?? $raw['lastName'] ?? '' );
        $email      = mancamp_sanitise_email( $raw['email'] ?? ( $idx === 0 ? ( $formData['email'] ?? '' ) : '' ) );
        $phone      = sanitize_text_field( $raw['phone'] ?? ( $idx === 0 ? ( $formData['phone'] ?? '' ) : '' ) );
        $notes      = sanitize_textarea_field( $raw['notes'] ?? '' );
        $age_group  = mancamp_normalise_age_group( $raw['age_group'] ?? $raw['ageGroup'] ?? '', $age );
        $is_minor = $age !== '' ? $age < 18 : $age_group === 'child';
        $lodging_preference = mancamp_normalise_lodging_preference(
            $raw['lodging_option_key'] ?? $raw['lodgingOptionKey'] ?? $default_option_key
        );
        $lodging_option_key = mancamp_normalise_lodging_preference(
            $raw['lodging_option_key'] ?? $raw['lodgingOptionKey'] ?? $lodging_preference
        );

        if ( $first_name === '' && $last_name === '' && $email === '' && $phone === '' ) {
            continue;
        }

        if ( $first_name === '' || $last_name === '' ) {
            return new WP_Error(
                'missing_person_name',
                'Each attendee must include both first and last name. Problem found at attendee #' . ( $idx + 1 ) . '.'
            );
        }

        $person = [
            'first_name'               => $first_name,
            'last_name'                => $last_name,
            'email'                    => $email,
            'phone'                    => $phone,
            'age_group'                => $age_group,
            'age'                      => $age,
            'program_type'             => sanitize_text_field( $raw['program_type'] ?? $raw['program'] ?? $raw['programType'] ?? $default_program ),
            'shirt_size'               => strtoupper( sanitize_text_field( $raw['shirt_size'] ?? $raw['shirt'] ?? $raw['shirtSize'] ?? $default_shirt ) ),
            'volunteer'                => mancamp_normalise_yes_no( $raw['volunteer'] ?? 'no' ),
            'attendance_type'          => mancamp_normalise_attendance_type( $raw['attendance_type'] ?? $raw['attendanceType'] ?? 'overnight' ),
            'guardian_link_key'        => sanitize_text_field( $raw['guardian_link_key'] ?? $raw['guardianLinkKey'] ?? '' ),
            'is_primary'               => ! empty( $raw['is_primary'] ) || ! empty( $raw['isPrimary'] ) || $idx === 0,
            'lodging_option_key'       => $lodging_option_key,
            'is_minor'                 => $is_minor,
            'notes'                    => $notes,
            'medical_notes'            => sanitize_textarea_field( $raw['medical_notes'] ?? '' ),
        ];

        $clean[] = $person;
    }

    if ( empty( $clean ) ) {
        return new WP_Error( 'empty_people', 'At least one attendee is required.' );
    }

    foreach ( $clean as $idx => &$person ) {
        $person['is_guardian'] = $person['age_group'] === 'adult' && mancamp_is_guardian_linked( $person, $idx, $clean );
    }
    unset( $person );

    return $clean;
}

function mancamp_build_single_person_from_fields( $formData ) {
    $first_name = sanitize_text_field( $formData['first_name'] ?? '' );
    $last_name  = sanitize_text_field( $formData['last_name'] ?? '' );
    $email      = mancamp_sanitise_email( $formData['email'] ?? '' );
    $phone      = sanitize_text_field( $formData['phone'] ?? '' );

    if ( $first_name === '' && $last_name === '' && $email === '' && $phone === '' ) {
        return [];
    }

    return [
        'first_name'               => $first_name,
        'last_name'                => $last_name,
        'email'                    => $email,
        'phone'                    => $phone,
        'age'                      => is_numeric( $formData['age'] ?? $formData['ageNum'] ?? null ) ? (int) ( $formData['age'] ?? $formData['ageNum'] ) : '',
        'age_group'                => mancamp_normalise_age_group( $formData['age_group'] ?? '', $formData['age'] ?? $formData['ageNum'] ?? null ),
        'program_type'             => sanitize_text_field( $formData['program_type'] ?? $formData['program'] ?? 'standard' ),
        'shirt_size'               => strtoupper( sanitize_text_field( $formData['shirt_size'] ?? $formData['shirt'] ?? '' ) ),
        'volunteer'                => 'no',
        'attendance_type'          => mancamp_normalise_attendance_type( $formData['attendance_type'] ?? 'overnight' ),
        'is_guardian'              => false,
        'is_minor'                 => mancamp_normalise_age_group( $formData['age_group'] ?? '', $formData['age'] ?? $formData['ageNum'] ?? null ) === 'child',
        'guardian_link_key'        => sanitize_text_field( $formData['guardian_link_key'] ?? '' ),
        'is_primary'               => true,
        'lodging_option_key'       => mancamp_normalise_lodging_preference( $formData['lodging_option_key'] ?? $formData['lodging_preference'] ?? '' ),
        'notes'                    => sanitize_textarea_field( $formData['notes'] ?? '' ),
        'medical_notes'            => sanitize_textarea_field( $formData['medical_notes'] ?? '' ),
    ];
}

function mancamp_sanitise_top_level_field( $field_key, $raw ) {
    if ( is_array( $raw ) ) {
        $raw = implode( ', ', array_map( 'sanitize_text_field', $raw ) );
    }

    if ( in_array( $field_key, MANCAMP_BOOLEAN_FIELDS, true ) ) {
        return mancamp_to_bool( $raw );
    }

    if ( $field_key === 'email' ) {
        return mancamp_sanitise_email( $raw );
    }

    if ( in_array( $field_key, [ 'ageNum', 'age', 'registration_total', 'processing_fee', 'attendee_count', 'rv_length' ], true ) ) {
        return is_numeric( $raw ) ? 0 + $raw : '';
    }

    if ( $field_key === 'lodging_option_key' ) {
        return mancamp_normalise_lodging_preference( $raw );
    }

    if ( $field_key === 'payment_method' ) {
        return mancamp_normalise_pay_type( $raw );
    }

    return in_array( $field_key, [ 'notes', 'medical_notes' ], true )
        ? sanitize_textarea_field( $raw )
        : sanitize_text_field( $raw );
}

function mancamp_sanitise_email( $raw ) {
    $value = sanitize_email( $raw );
    return is_email( $value ) ? $value : '';
}

function mancamp_to_bool( $value ) {
    return filter_var( $value, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE ) ?? false;
}

function mancamp_normalise_age_group( $value, $age = null ) {
    $normalised = strtolower( sanitize_text_field( (string) $value ) );
    if ( in_array( $normalised, MANCAMP_VALID_AGE_GROUPS, true ) ) {
        return $normalised;
    }

    if ( is_numeric( $age ) && (int) $age < 18 ) {
        return 'child';
    }

    return 'adult';
}

function mancamp_normalise_lodging_preference( $value ) {
    $normalised = strtolower( sanitize_text_field( (string) $value ) );
    if ( $normalised === 'cabin_with_bath' ) {
        $normalised = 'shared_cabin_connected';
    } elseif ( $normalised === 'cabin_without_bath' ) {
        $normalised = 'shared_cabin_detached';
    } elseif ( $normalised === 'cabin_connected' ) {
        $normalised = 'shared_cabin_connected';
    } elseif ( $normalised === 'cabin_detached' ) {
        $normalised = 'shared_cabin_detached';
    } elseif ( $normalised === 'rv' ) {
        $normalised = 'rv_hookups';
    } elseif ( $normalised === 'tent' ) {
        $normalised = 'tent_no_hookups';
    } elseif ( $normalised === 'sabbath_attendance_only' ) {
        $normalised = 'sabbath_attendance_only';
    } elseif ( $normalised === 'sabbath_only' ) {
        $normalised = 'sabbath_attendance_only';
    }

    if ( in_array( $normalised, MANCAMP_VALID_LODGING_PREFERENCES, true ) ) {
        return $normalised;
    }

    return 'shared_cabin_connected';
}

function mancamp_normalise_pay_type( $value ) {
    $normalised = strtolower( sanitize_text_field( (string) $value ) );
    if ( in_array( $normalised, mancamp_offline_values(), true ) ) {
        return 'offline';
    }
    return 'square';
}

function mancamp_normalise_attendance_type( $value ) {
    $normalised = strtolower( sanitize_text_field( (string) $value ) );
    return $normalised === 'sabbath_only' ? 'sabbath_only' : 'overnight';
}

function mancamp_normalise_yes_no( $value ) {
    return strtolower( sanitize_text_field( (string) $value ) ) === 'yes' ? 'yes' : 'no';
}

function mancamp_collect_payment_meta( $form_data, $payment = [], $top_level = [] ) {
    $method = mancamp_normalise_pay_type(
        $payment['payment_method'] ?? $payment['payment_mode'] ?? $payment['method'] ?? $top_level['payment_method'] ?? mancamp_pick_field( $form_data, [ 'mc_payment_method_out', 'payment_method', 'pay_type' ], 'square' )
    );
    $status = strtolower( sanitize_text_field(
        $payment['payment_status'] ?? $payment['status'] ?? $payment['transaction_status'] ?? 'paid'
    ) );
    $reference = sanitize_text_field(
        $payment['payment_reference'] ?? $payment['transaction_id'] ?? $payment['charge_id'] ?? $payment['transaction_hash'] ?? $payment['reference'] ?? ''
    );
    $registration_total = mancamp_format_money( $top_level['registration_total'] ?? mancamp_pick_field( $form_data, [ 'registration_total' ], 0 ) );
    $processing_fee = $method === 'square'
        ? mancamp_format_money( $top_level['processing_fee'] ?? mancamp_pick_field( $form_data, [ 'processing_fee' ], 0 ) )
        : mancamp_format_money( 0 );
    $amount_paid_raw = $payment['payment_total'] ?? $payment['paid_total'] ?? $payment['total'] ?? $payment['amount'] ?? '';
    if ( $amount_paid_raw === '' ) {
        $amount_paid_raw = (float) $registration_total + (float) $processing_fee;
    }
    $amount_paid = mancamp_format_money( $amount_paid_raw );

    return [
        'method'            => $method,
        'status'            => $status,
        'reference'         => $reference,
        'amountPaid'        => $amount_paid,
        'registrationTotal' => $registration_total,
        'processingFee'     => $processing_fee,
    ];
}

function mancamp_pick_field( $formData, $names, $default = '' ) {
    foreach ( $names as $name ) {
        if ( isset( $formData[ $name ] ) && $formData[ $name ] !== '' ) {
            return $formData[ $name ];
        }
        $alt_name = str_replace( [ '-', ' ' ], '_', strtolower( $name ) );
        if ( isset( $formData[ $alt_name ] ) && $formData[ $alt_name ] !== '' ) {
            return $formData[ $alt_name ];
        }
    }
    return $default;
}

function mancamp_normalise_enum( $value, $valid_values ) {
    $normalised = strtolower( sanitize_text_field( (string) $value ) );
    return in_array( $normalised, $valid_values, true ) ? $normalised : '';
}

function mancamp_extract_lodging_request( $formData, $primary ) {
    $json = mancamp_pick_field( $formData, [ 'lodging_request_json' ], '' );
    if ( $json !== '' ) {
        $decoded = json_decode( wp_unslash( $json ), true );
        if ( json_last_error() === JSON_ERROR_NONE && is_array( $decoded ) ) {
            return [
                'type'         => mancamp_normalise_lodging_preference( $decoded['type'] ?? $decoded['lodging_option_key'] ?? '' ),
                'rvAmp'        => isset( $decoded['rvAmp'] ) && $decoded['rvAmp'] !== '' ? sanitize_text_field( $decoded['rvAmp'] ) : null,
                'rvLengthFeet' => isset( $decoded['rvLengthFeet'] ) && $decoded['rvLengthFeet'] !== '' ? (int) $decoded['rvLengthFeet'] : null,
                'notes'        => sanitize_textarea_field( $decoded['notes'] ?? '' ),
            ];
        }
    }

    $type = mancamp_normalise_lodging_preference(
        mancamp_pick_field( $formData, [ 'lodging_option_key', 'lodging_preference' ], $primary['lodging_option_key'] ?? '' )
    );

    return [
        'type'         => $type,
        'rvAmp'        => $type === 'rv_hookups' && mancamp_pick_field( $formData, [ 'rv_amp' ], '' ) !== '' ? sanitize_text_field( mancamp_pick_field( $formData, [ 'rv_amp' ], '' ) ) : null,
        'rvLengthFeet' => $type === 'rv_hookups' && mancamp_pick_field( $formData, [ 'rv_length' ], '' ) !== '' ? (int) mancamp_pick_field( $formData, [ 'rv_length' ], '' ) : null,
        'notes'        => sanitize_textarea_field( $formData['notes'] ?? '' ),
    ];
}

function mancamp_resolve_attendee_count( $top_level, $people ) {
    $count = isset( $top_level['attendee_count'] ) && is_numeric( $top_level['attendee_count'] )
        ? (int) $top_level['attendee_count']
        : count( $people );

    return $count > 0 ? $count : count( $people );
}

function mancamp_warn_for_missing_fields( $entry_id, $top_level ) {
    $required_fields = [
        'people_json',
        'roster_json',
        'attendee_count',
        'lodging_option_key',
        'lodging_option_label',
        'lodging_request_json',
        'rv_amp',
        'rv_length',
        'registration_total',
        'processing_fee',
        'payment_method',
        'attendees_json',
    ];

    foreach ( $required_fields as $field ) {
        if ( isset( $top_level[ $field ] ) && $top_level[ $field ] !== '' ) {
            continue;
        }
        mancamp_log( '[entry ' . (int) $entry_id . '][warning] Missing hidden field "' . $field . '" in Fluent Forms submission.', 'error' );
    }
}

function mancamp_submission_timestamp( $submission ) {
    $source = $submission['created_at'] ?? $submission['createdAt'] ?? '';
    $timestamp = $source ? strtotime( $source ) : false;

    return $timestamp ? gmdate( 'c', $timestamp ) : current_time( 'c', true );
}

function mancamp_lodging_label( $key ) {
    $labels = [
        'shared_cabin_connected'  => 'Shared Cabin - Connected Restroom',
        'shared_cabin_detached'   => 'Shared Cabin - Detached Restroom/Shower',
        'rv_hookups'              => 'RV Hookups',
        'tent_no_hookups'         => 'Tent Camping - No Hookups',
        'sabbath_attendance_only' => 'Sabbath Attendance Only',
    ];
    return $labels[ $key ] ?? $key;
}

function mancamp_is_guardian_linked( $person, $person_index, $people ) {
    $link_key = sanitize_title( $person['first_name'] . '-' . $person['last_name'] ) . '-' . $person_index;
    foreach ( $people as $idx => $candidate ) {
        if ( $idx === $person_index ) continue;
        if ( ( $candidate['guardian_link_key'] ?? '' ) === $link_key ) {
            return true;
        }
    }
    return false;
}

function mancamp_format_money( $value ) {
    $number = is_numeric( $value ) ? (float) $value : 0.0;
    return number_format( $number, 2, '.', '' );
}


// ============================================================
// SECTION 9 — GAS HTTP POST
// ============================================================

function mancamp_post_to_gas( $payload ) {
    $url = mancamp_gas_url();
    if ( empty( $url ) ) {
        return new WP_Error( 'no_gas_url', 'GAS URL not configured. Go to Settings -> Man Camp Registration.' );
    }

    $body = wp_json_encode( $payload );
    if ( $body === false ) {
        return new WP_Error( 'json_encode_failed', 'Could not JSON-encode payload.' );
    }

    $request_args = [
        'method'      => 'POST',
        'timeout'     => MANCAMP_HTTP_TIMEOUT,
        'redirection' => 0,   // Do NOT auto-follow — GAS issues a 302 that wp_remote_post
                              // would follow with GET, silently dropping the POST body.
        'httpversion' => '1.1',
        'headers'     => [
            'Content-Type' => 'application/json; charset=utf-8',
            'Accept'       => 'application/json',
        ],
        'body'      => $body,
        'sslverify' => true,
    ];

    $response = wp_remote_post( $url, $request_args );

    if ( is_wp_error( $response ) ) return $response;

    $http_code = wp_remote_retrieve_response_code( $response );
    mancamp_log( 'GAS initial HTTP ' . $http_code );

    // GAS web apps issue a 302 redirect on POST.  The redirect destination is
    // typically script.googleusercontent.com/macros/echo?... — an echo endpoint
    // that returns the pre-computed script result via GET.  Re-issuing POST to
    // that URL returns HTTP 405.  Fix: follow 302/301/303 redirects with GET when
    // the Location is cross-domain (echo URL); keep POST for same-domain redirects
    // (auth hops on script.google.com) and always for 307/308.  Also handle up to
    // 5 hops in case there are multiple auth redirects before the echo URL.
    $max_hops = 5;
    $hop      = 0;
    while ( $hop < $max_hops && in_array( $http_code, [ 301, 302, 303, 307, 308 ], true ) ) {
        $hop++;
        $location = wp_remote_retrieve_header( $response, 'location' );
        if ( empty( $location ) ) {
            return new WP_Error( 'gas_redirect_no_location', 'GAS redirected but returned no Location header.' );
        }
        mancamp_log( 'GAS redirect ' . $http_code . ' (hop ' . $hop . ') → ' . $location );

        // 307/308 must maintain POST.
        // 301/302/303: keep POST only for same-domain (script.google.com) auth hops;
        // use GET for cross-domain redirects (e.g. script.googleusercontent.com echo URL).
        $use_post = in_array( $http_code, [ 307, 308 ], true )
                    || (bool) preg_match( '#^https://script\.google\.com#i', $location );

        if ( $use_post ) {
            $response = wp_remote_post( $location, array_merge( $request_args, [ 'redirection' => 0 ] ) );
        } else {
            $response = wp_remote_get( $location, [
                'timeout'     => MANCAMP_HTTP_TIMEOUT,
                'redirection' => 0,
                'httpversion' => '1.1',
                'headers'     => [ 'Accept' => 'application/json' ],
                'sslverify'   => true,
            ] );
        }

        if ( is_wp_error( $response ) ) return $response;
        $http_code = wp_remote_retrieve_response_code( $response );
        mancamp_log( 'GAS hop ' . $hop . ' HTTP ' . $http_code );

        // Safety net: if POST to redirect returned 405, fall back to GET on same URL.
        if ( $http_code === 405 && $use_post ) {
            mancamp_log( 'GAS 405 on POST — retrying hop ' . $hop . ' with GET: ' . $location );
            $response = wp_remote_get( $location, [
                'timeout'     => MANCAMP_HTTP_TIMEOUT,
                'redirection' => 0,
                'httpversion' => '1.1',
                'headers'     => [ 'Accept' => 'application/json' ],
                'sslverify'   => true,
            ] );
            if ( is_wp_error( $response ) ) return $response;
            $http_code = wp_remote_retrieve_response_code( $response );
            mancamp_log( 'GAS fallback GET HTTP ' . $http_code );
        }
    }

    $response_body = wp_remote_retrieve_body( $response );
    mancamp_log( 'GAS body - ' . substr( $response_body, 0, 500 ) );

    if ( $http_code < 200 || $http_code >= 300 ) {
        return new WP_Error( 'gas_http_error', 'GAS returned HTTP ' . $http_code );
    }

    $decoded = json_decode( $response_body, true );
    if ( json_last_error() !== JSON_ERROR_NONE ) {
        // GAS sometimes wraps the JSON payload — try to extract it with a regex.
        preg_match( '/\{.*\}/s', $response_body, $m );
        if ( ! empty( $m[0] ) ) $decoded = json_decode( $m[0], true );
        if ( json_last_error() !== JSON_ERROR_NONE ) {
            return new WP_Error( 'invalid_gas_response', 'GAS response is not valid JSON. Body: ' . substr( $response_body, 0, 200 ) );
        }
    }

    // Validate the GAS-level success flag
    if ( isset( $decoded['success'] ) && $decoded['success'] === false ) {
        if ( ! empty( $decoded['duplicate'] ) ) {
            mancamp_log( 'GAS duplicate - skipping.' );
            return $decoded;
        }
        return new WP_Error( 'gas_logic_error', 'GAS failure: ' . ( $decoded['error'] ?? 'Unknown' ) );
    }

    // Guard: if we got HTTP 200 but the response looks like the doGet() health-check
    // rather than a real registration response, treat it as a silent failure.
    if ( isset( $decoded['status'] ) && $decoded['status'] === 'ok' && ! isset( $decoded['registrationId'] ) && ! isset( $decoded['success'] ) ) {
        return new WP_Error(
            'gas_got_health_check',
            'GAS returned a health-check response instead of a registration response. ' .
            'The POST may have been silently converted to GET. Check your GAS deployment URL.'
        );
    }

    return $decoded;
}


// ============================================================
// SECTION 10 — FAILURE STORAGE
// ============================================================

function mancamp_store_failed_payload( $insertId, $payload, $error, $is_retry = false ) {
    $failed = get_option( MANCAMP_FAILED_WEBHOOKS_OPTION, [] );
    $updated = false;

    foreach ( $failed as &$entry ) {
        if ( (int) ( $entry['entry_id'] ?? 0 ) !== (int) $insertId ) {
            continue;
        }
        $entry['payload'] = $payload;
        $entry['failed_at'] = $entry['failed_at'] ?? current_time( 'mysql' );
        $entry['attempts'] = $is_retry ? ( (int) ( $entry['attempts'] ?? 1 ) + 1 ) : (int) ( $entry['attempts'] ?? 1 );
        $updated = true;
        break;
    }
    unset( $entry );

    if ( ! $updated ) {
        $failed[] = [
            'entry_id'  => (int) $insertId,
            'payload'   => $payload,
            'failed_at' => current_time( 'mysql' ),
            'attempts'  => 1,
        ];
    }

    update_option( MANCAMP_FAILED_WEBHOOKS_OPTION, array_values( $failed ), false );
    mancamp_schedule_retry_event();
    mancamp_log( 'Failed payload stored for entry ' . $insertId . ': ' . $error, 'error' );
}

function mancamp_remove_failed_payload( $insertId ) {
    $failed = array_values( array_filter(
        get_option( MANCAMP_FAILED_WEBHOOKS_OPTION, [] ),
        static function ( $entry ) use ( $insertId ) {
            return (int) ( $entry['entry_id'] ?? 0 ) !== (int) $insertId;
        }
    ) );
    update_option( MANCAMP_FAILED_WEBHOOKS_OPTION, $failed, false );
}

function mancamp_add_cron_schedule( $schedules ) {
    $schedules['mancamp_every_15_minutes'] = [
        'interval' => 15 * MINUTE_IN_SECONDS,
        'display'  => 'Every 15 Minutes (Man Camp)',
    ];
    $schedules['mancamp_every_30_minutes'] = [
        'interval' => 30 * MINUTE_IN_SECONDS,
        'display'  => 'Every 30 Minutes (Man Camp Offline Sweep)',
    ];
    return $schedules;
}

function mancamp_schedule_retry_event() {
    if ( ! wp_next_scheduled( MANCAMP_RETRY_HOOK ) ) {
        wp_schedule_event( time() + ( 15 * MINUTE_IN_SECONDS ), 'mancamp_every_15_minutes', MANCAMP_RETRY_HOOK );
    }
}

function mancamp_schedule_offline_sweep_event() {
    if ( ! wp_next_scheduled( MANCAMP_OFFLINE_SWEEP_HOOK ) ) {
        wp_schedule_event( time() + ( 30 * MINUTE_IN_SECONDS ), 'mancamp_every_30_minutes', MANCAMP_OFFLINE_SWEEP_HOOK );
    }
}

function mancamp_retry_failed_webhooks() {
    $failed = get_option( MANCAMP_FAILED_WEBHOOKS_OPTION, [] );
    if ( empty( $failed ) ) {
        return;
    }

    $remaining = [];
    foreach ( $failed as $entry ) {
        $attempts = (int) ( $entry['attempts'] ?? 1 );
        if ( $attempts >= 3 ) {
            $remaining[] = $entry;
            continue;
        }

        mancamp_log_event( (int) ( $entry['entry_id'] ?? 0 ), 'retry', 'Cron retry attempting webhook delivery.' );
        $result = mancamp_process_entry_webhook( (int) ( $entry['entry_id'] ?? 0 ), [], true );
        if ( is_wp_error( $result ) ) {
            $remaining[] = $entry;
            continue;
        }
    }

    update_option( MANCAMP_FAILED_WEBHOOKS_OPTION, array_values( $remaining ), false );
}

function mancamp_sweep_offline_submissions() {
    $status = get_option( MANCAMP_OFFLINE_SWEEP_STATUS_OPTION, [
        'last_run' => '',
        'processed_count' => 0,
    ] );
    $processed_count = 0;

    if ( ! function_exists( 'wpFluent' ) || ! mancamp_form_id() ) {
        $status['last_run'] = current_time( 'mysql' );
        $status['processed_count'] = 0;
        update_option( MANCAMP_OFFLINE_SWEEP_STATUS_OPTION, $status, false );
        return;
    }

    try {
        $submissions = wpFluent()->table( 'fluentform_submissions' )
            ->where( 'form_id', mancamp_form_id() )
            ->where( 'created_at', '>=', date( 'Y-m-d H:i:s', strtotime( '-48 hours' ) ) )
            ->get();
    } catch ( Exception $e ) {
        mancamp_log_event( 0, 'failed', 'Offline sweep query failed: ' . $e->getMessage() );
        $status['last_run'] = current_time( 'mysql' );
        $status['processed_count'] = 0;
        update_option( MANCAMP_OFFLINE_SWEEP_STATUS_OPTION, $status, false );
        return;
    }

    foreach ( $submissions as $submission ) {
        $submission_record = mancamp_normalise_submission_argument( $submission );
        if ( is_wp_error( $submission_record ) ) {
            continue;
        }

        $entry_id = (int) ( $submission_record['id'] ?? 0 );
        if ( $entry_id <= 0 || mancamp_has_sent_entry_id( $entry_id ) ) {
            continue;
        }

        if ( ! mancamp_is_offline_submission( $submission_record ) ) {
            continue;
        }

        $processed_count++;
        mancamp_process_entry_webhook( $entry_id, [
            'submission' => $submission_record,
            'payment'    => mancamp_get_payment_record( $entry_id ),
        ], false, 'offline_sweep', 'Offline sweep attempting webhook delivery.' );
    }

    $status['last_run'] = current_time( 'mysql' );
    $status['processed_count'] = $processed_count;
    update_option( MANCAMP_OFFLINE_SWEEP_STATUS_OPTION, $status, false );
}

function mancamp_admin_notice_for_stale_failures() {
    if ( ! current_user_can( 'manage_options' ) ) {
        return;
    }

    $failed = get_option( MANCAMP_FAILED_WEBHOOKS_OPTION, [] );
    if ( empty( $failed ) ) {
        return;
    }

    $threshold = time() - HOUR_IN_SECONDS;
    foreach ( $failed as $entry ) {
        $failed_at = isset( $entry['failed_at'] ) ? strtotime( $entry['failed_at'] ) : false;
        if ( $failed_at && $failed_at <= $threshold ) {
            echo '<div class="notice notice-error"><p>Man Camp webhook retries still have failed entries older than 1 hour. Review Settings -> Man Camp Registration.</p></div>';
            return;
        }
    }
}


// ============================================================
// SECTION 11 — ADMIN MENU & ACTION HANDLERS
// ============================================================

function mancamp_admin_menu() {
    add_submenu_page(
        'options-general.php',
        'Man Camp Registration',
        'Man Camp Registration',
        'manage_options',
        'mancamp-registration',
        'mancamp_admin_page'
    );
}

function mancamp_save_settings() {
    if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Insufficient permissions.' );
    check_admin_referer( 'mancamp_save_settings', 'mancamp_settings_nonce' );

    update_option( MANCAMP_OPTION_GROUP, [
        'gas_url'        => esc_url_raw( trim( $_POST['gas_url']        ?? '' ) ),
        'form_id'        => (int) ( $_POST['form_id']        ?? 0 ),
        'page_slug'      => trim( sanitize_text_field( $_POST['page_slug']      ?? '' ), '/' ),
        'debug_mode'     => isset( $_POST['debug_mode'] ),
        'offline_values' => sanitize_text_field( $_POST['offline_values'] ?? '' ),
    ] );

    wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&saved=1' ) );
    exit;
}

function mancamp_handle_retry() {
    if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Insufficient permissions.' );
    check_admin_referer( 'mancamp_retry', 'mancamp_retry_nonce' );

    $entry_id = (int) ( $_POST['mancamp_retry_entry_id'] ?? 0 );

    if ( $entry_id === 0 ) {
        mancamp_retry_failed_webhooks();
        wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&retry_ok=' . urlencode( 'batch' ) ) );
        exit;
    }

    if ( $entry_id > 0 ) {
        mancamp_log_event( $entry_id, 'retry', 'Manual retry attempting webhook delivery.' );
        $result = mancamp_process_entry_webhook( $entry_id, [], true );
        if ( is_wp_error( $result ) ) {
            wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&retry_failed=' . urlencode( $result->get_error_message() ) ) );
        } else {
            if ( ! empty( $result['duplicate'] ) ) {
                wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&retry_ok=' . urlencode( 'already-processed' ) ) );
            } else {
                wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&retry_ok=' . urlencode( 'sent' ) ) );
            }
        }
    } else {
        wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&retry_failed=' . urlencode( 'Failed webhook entry not found.' ) ) );
    }
    exit;
}

function mancamp_handle_manual_resync() {
    if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Insufficient permissions.' );
    check_admin_referer( 'mancamp_manual_resync', 'mancamp_manual_nonce' );

    $ff_entry_id = (int) ( $_POST['mancamp_manual_entry_id'] ?? 0 );

    if ( $ff_entry_id > 0 && function_exists( 'wpFluentForm' ) ) {
        try {
            $result = mancamp_process_entry_webhook( $ff_entry_id, [], true );
            if ( ! is_wp_error( $result ) ) {
                wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&resync_ok=' . $ff_entry_id ) );
                exit;
            }
            wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&resync_failed=' . urlencode( $result->get_error_message() ) ) );
            exit;
        } catch ( Exception $e ) {
            wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&resync_failed=' . urlencode( $e->getMessage() ) ) );
            exit;
        }
    }

    wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&resync_failed=' . urlencode( 'Entry not found.' ) ) );
    exit;
}

function mancamp_handle_run_offline_sweep() {
    if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Insufficient permissions.' );
    check_admin_referer( 'mancamp_run_offline_sweep', 'mancamp_run_offline_sweep_nonce' );

    mancamp_sweep_offline_submissions();
    wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&sweep_ok=1' ) );
    exit;
}


// ============================================================
// SECTION 12 — ADMIN PAGE RENDER
// ============================================================

function mancamp_admin_page() {
    if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Insufficient permissions.' );

    $gas_url        = mancamp_gas_url();
    $form_id        = mancamp_form_id();
    $page_slug      = mancamp_page_slug();
    $debug_mode     = mancamp_debug();
    $offline_values = implode( ', ', mancamp_offline_values() );

    $gas_ok  = ! empty( $gas_url );
    $form_ok = $form_id > 0;
    $slug_ok = ! empty( $page_slug );
    $js_ok   = file_exists( plugin_dir_path( __FILE__ ) . 'man-camp-registration.js' );

    $all_pages = get_pages( [ 'post_status' => 'publish', 'number' => 200 ] );

    $ff_forms = [];
    if ( function_exists( 'wpFluentForm' ) ) {
        try {
            $ff_forms = wpFluentForm()->make( 'FluentForm\App\Models\Form' )
                ->select( [ 'id', 'title' ] )->orderBy( 'id', 'asc' )->get()->toArray();
        } catch ( Exception $e ) {}
    }

    $saved       = isset( $_GET['saved'] );
    $retry_ok    = $_GET['retry_ok']      ?? false;
    $retry_fail  = $_GET['retry_failed']  ?? false;
    $resync_ok   = $_GET['resync_ok']     ?? false;
    $resync_fail = $_GET['resync_failed'] ?? false;
    $sweep_ok    = isset( $_GET['sweep_ok'] );

    $failed_entries = get_option( MANCAMP_FAILED_WEBHOOKS_OPTION, [] );
    $webhook_log = array_reverse( array_slice( get_option( MANCAMP_WEBHOOK_LOG_OPTION, [] ), -50 ) );
    $offline_sweep_status = get_option( MANCAMP_OFFLINE_SWEEP_STATUS_OPTION, [
        'last_run' => '',
        'processed_count' => 0,
    ] );

    ?>
    <div class="wrap" style="max-width:900px;">
    <h1>Man Camp Registration Settings</h1>

    <?php if ( $saved ) : ?>
      <div class="notice notice-success is-dismissible"><p>✔ Settings saved.</p></div>
    <?php endif; ?>
    <?php if ( $retry_ok ) : ?>
      <?php if ( $retry_ok === 'already-processed' ) : ?>
        <div class="notice notice-success is-dismissible"><p>✔ Already processed — this registration was received by GAS on the original submission. The failed entry has been cleared.</p></div>
      <?php elseif ( $retry_ok === 'batch' ) : ?>
        <div class="notice notice-success is-dismissible"><p>✔ Manual retry pass finished for all pending failed webhooks.</p></div>
      <?php else : ?>
        <div class="notice notice-success is-dismissible"><p>✔ Retry successful — GAS ID: <code><?php echo esc_html( $retry_ok ); ?></code></p></div>
      <?php endif; ?>
    <?php endif; ?>
    <?php if ( $retry_fail ) : ?>
      <div class="notice notice-error is-dismissible"><p>✘ Retry failed: <?php echo esc_html( $retry_fail ); ?></p></div>
    <?php endif; ?>
    <?php if ( $resync_ok ) : ?>
      <div class="notice notice-success is-dismissible"><p>✔ Resync triggered for FF entry #<?php echo esc_html( $resync_ok ); ?>.</p></div>
    <?php endif; ?>
    <?php if ( $resync_fail ) : ?>
      <div class="notice notice-error is-dismissible"><p>✘ Resync failed: <?php echo esc_html( $resync_fail ); ?></p></div>
    <?php endif; ?>
    <?php if ( $sweep_ok ) : ?>
      <div class="notice notice-success is-dismissible"><p>✔ Offline payment sweep completed.</p></div>
    <?php endif; ?>


    <!-- ── Settings Form ──────────────────────────────────────────── -->
    <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:24px;margin-bottom:24px;">
      <h2 style="margin-top:0;">Connection Settings</h2>
      <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
        <?php wp_nonce_field( 'mancamp_save_settings', 'mancamp_settings_nonce' ); ?>
        <input type="hidden" name="action" value="mancamp_save_settings">
        <table class="form-table" role="presentation">
          <tbody>

            <!-- GAS URL -->
            <tr>
              <th scope="row"><label for="gas_url">GAS Web App URL</label></th>
              <td>
                <input type="url" id="gas_url" name="gas_url"
                  value="<?php echo esc_attr( $gas_url ); ?>"
                  class="regular-text"
                  placeholder="https://script.google.com/macros/s/..."
                  required>
                <p class="description">
                  GAS Editor → Deploy → Manage Deployments → Web App URL.
                  <?php if ( $gas_ok ) : ?>
                    <a href="<?php echo esc_url( $gas_url . '?action=ping' ); ?>" target="_blank" style="margin-left:6px;">
                      Ping GAS ↗
                    </a>
                  <?php endif; ?>
                </p>
              </td>
            </tr>

            <!-- Form ID -->
            <tr>
              <th scope="row"><label for="form_id">Fluent Form ID</label></th>
              <td>
                <input type="number" id="form_id" name="form_id"
                  value="<?php echo esc_attr( $form_id ); ?>"
                  class="small-text" min="1" required>
                <?php if ( ! empty( $ff_forms ) ) : ?>
                <p class="description">
                  Available forms — click to select:&nbsp;
                  <?php foreach ( $ff_forms as $i => $f ) :
                    $comma = $i < count( $ff_forms ) - 1 ? ' &bull; ' : '';
                  ?>
                    <a href="#" onclick="document.getElementById('form_id').value=<?php echo (int) $f['id']; ?>;return false;">
                      <?php echo esc_html( $f['title'] ); ?> (ID&nbsp;<?php echo (int) $f['id']; ?>)
                    </a><?php echo $comma; ?>
                  <?php endforeach; ?>
                </p>
                <?php else : ?>
                <p class="description">Find the ID in Fluent Forms → All Forms → ID column.</p>
                <?php endif; ?>
              </td>
            </tr>

            <!-- Page Slug -->
            <tr>
              <th scope="row"><label for="page_slug">Registration Page Slug</label></th>
              <td>
                <input type="text" id="page_slug" name="page_slug"
                  value="<?php echo esc_attr( $page_slug ); ?>"
                  class="regular-text"
                  placeholder="event/man-camp-registration"
                  required>
                <p class="description">Slug or path of the page where the form lives (for example `event/man-camp-registration`). Case-sensitive.</p>
                <?php if ( ! empty( $all_pages ) ) : ?>
                <p class="description">
                  Pick from your published pages:&nbsp;
                  <select onchange="document.getElementById('page_slug').value=this.value;this.value='';" style="max-width:260px;">
                    <option value="">— select to fill in —</option>
                    <?php foreach ( $all_pages as $p ) : ?>
                      <option value="<?php echo esc_attr( $p->post_name ); ?>">
                        <?php echo esc_html( $p->post_title ); ?> — <?php echo esc_html( $p->post_name ); ?>
                      </option>
                    <?php endforeach; ?>
                  </select>
                </p>
                <?php endif; ?>
              </td>
            </tr>

            <!-- Offline Payment Values -->
            <tr>
              <th scope="row"><label for="offline_values">Offline Payment Values</label></th>
              <td>
                <input type="text" id="offline_values" name="offline_values"
                  value="<?php echo esc_attr( $offline_values ); ?>"
                  class="regular-text"
                  placeholder="offline, check, cash, test">
                <p class="description">
                  Comma-separated list of payment method values that should bypass Square and be treated as offline/cash.
                  These must match the exact option values in your Fluent Forms payment field (e.g. <code>test</code>, <code>check</code>, <code>cash</code>).
                  The widget reads this list to zero out the processing fee and suppress Square.
                </p>
              </td>
            </tr>

            <!-- Debug Mode -->
            <tr>
              <th scope="row">Debug Mode</th>
              <td>
                <label>
                  <input type="checkbox" name="debug_mode" value="1" <?php checked( $debug_mode ); ?>>
                  Log debug info to the PHP error log
                </label>
                <?php if ( $debug_mode ) : ?>
                  <p class="description" style="color:#d63638;">⚠ Debug is ON — turn off in production.</p>
                <?php endif; ?>
              </td>
            </tr>

          </tbody>
        </table>
        <?php submit_button( 'Save Settings' ); ?>
      </form>
    </div>

    <!-- ── Offline Payment Sweep ───────────────────────────────────── -->
    <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:24px;margin-bottom:24px;">
      <h2 style="margin-top:0;">Offline Payment Sweep</h2>
      <p><strong>Last Sweep Run:</strong> <?php echo esc_html( $offline_sweep_status['last_run'] ?: 'Never' ); ?></p>
      <p><strong>Processed In Last Sweep:</strong> <?php echo (int) ( $offline_sweep_status['processed_count'] ?? 0 ); ?></p>
      <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
        <?php wp_nonce_field( 'mancamp_run_offline_sweep', 'mancamp_run_offline_sweep_nonce' ); ?>
        <input type="hidden" name="action" value="mancamp_run_offline_sweep">
        <button type="submit" class="button">Run Sweep Now</button>
      </form>
    </div>


    <!-- ── Status Panel ──────────────────────────────────────────────── -->
    <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:24px;margin-bottom:24px;">
      <h2 style="margin-top:0;">Status</h2>
      <table class="widefat" style="max-width:620px;">
        <tbody>
          <?php
          $checks = [
              [ 'GAS URL',     $gas_ok,     $gas_ok   ? 'Configured'                                        : 'Not set — enter URL above' ],
              [ 'Form ID',     $form_ok,    $form_ok  ? 'ID: ' . $form_id                                   : 'Set to 0 — select form above' ],
              [ 'Page Slug',   $slug_ok,    $slug_ok  ? $page_slug                                           : 'Not set' ],
              [ 'People JS',   $js_ok,      $js_ok    ? 'man-camp-registration.js found in plugin folder'          : 'NOT FOUND — upload man-camp-registration.js to the plugin folder' ],
              [ 'Debug Mode',  !$debug_mode, $debug_mode ? 'ON — disable in production'                     : 'OFF' ],
          ];
          foreach ( $checks as [ $label, $ok, $text ] ) : ?>
          <tr>
            <td style="width:130px;"><strong><?php echo esc_html( $label ); ?></strong></td>
            <td>
              <span style="color:<?php echo $ok ? 'green' : '#d63638'; ?>;"><?php echo $ok ? '✔' : '✘'; ?></span>
              <?php echo esc_html( $text ); ?>
            </td>
          </tr>
          <?php endforeach; ?>
        </tbody>
      </table>
    </div>


    <!-- ── Field Reference ───────────────────────────────────────────── -->
    <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:24px;margin-bottom:24px;">
      <h2 style="margin-top:0;">Fluent Forms Field Name Reference <span style="color:#646970;font-size:13px;font-weight:400;">(v2.3.0)</span></h2>
      <p style="color:#646970;font-size:13px;">These are the preferred Fluent Forms field names for the Man Camp form. Use them as the field <strong>Name</strong> values in the form builder.</p>
      <table class="widefat striped" style="font-size:12px;">
        <thead><tr><th>FF Field Name</th><th>GAS Key</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>first_name</code></td>              <td><code>first_name</code></td>              <td>Text</td>     <td>Primary registrant first name</td></tr>
          <tr><td><code>last_name</code></td>               <td><code>last_name</code></td>               <td>Text</td>     <td>Primary registrant last name</td></tr>
          <tr><td><code>email</code></td>                   <td><code>email</code></td>                   <td>Email</td>    <td>Primary contact email</td></tr>
          <tr><td><code>phone</code></td>                   <td><code>phone</code></td>                   <td>Phone</td>    <td>Primary contact phone</td></tr>
          <tr><td><code>age</code></td>                     <td><code>age</code></td>                     <td>Number</td>   <td>Primary registrant age when the builder mirrors this field directly</td></tr>
          <tr><td><code>age_group</code></td>               <td><code>age_group</code></td>               <td>Hidden</td>   <td><code>adult</code> or <code>child</code></td></tr>
          <tr><td><code>is_minor</code></td>                <td><code>is_minor</code></td>                <td>Hidden</td>   <td>Primary attendee minor flag</td></tr>
          <tr><td><code>is_guardian</code></td>             <td><code>is_guardian</code></td>             <td>Hidden</td>   <td>Primary attendee guardian flag</td></tr>
          <tr><td><code>program_type</code></td>            <td><code>program_type</code></td>            <td>Hidden</td>   <td>Program selection for the primary attendee</td></tr>
          <tr><td><code>shirt_size</code></td>              <td><code>shirt_size</code></td>              <td>Hidden</td>   <td>Primary attendee shirt size</td></tr>
          <tr><td><code>lodging_option_key</code></td>      <td><code>lodging_option_key</code></td>      <td>Hidden</td>   <td><code>shared_cabin_connected</code>, <code>shared_cabin_detached</code>, <code>rv_hookups</code>, <code>tent_no_hookups</code>, <code>sabbath_attendance_only</code></td></tr>
          <tr><td><code>lodging_option_label</code></td>    <td><code>lodging_option_label</code></td>    <td>Hidden</td>   <td>Human-readable lodging label</td></tr>
          <tr><td><code>lodging_request_json</code></td>    <td><code>lodging_request_json</code></td>    <td>Hidden</td>   <td>JSON with type, RV details, and notes</td></tr>
          <tr><td><code>attendance_type</code></td>         <td><code>attendance_type</code></td>         <td>Hidden</td>   <td><code>overnight</code> or <code>sabbath_only</code></td></tr>
          <tr><td><code>people_json</code></td>             <td><code>people_json</code></td>             <td>Hidden</td>   <td>Canonical attendee roster JSON written by the widget</td></tr>
          <tr><td><code>roster_json</code></td>             <td><code>roster_json</code></td>             <td>Hidden</td>   <td>Backward-compatibility mirror of <code>people_json</code></td></tr>
          <tr><td><code>attendee_count</code></td>          <td><code>attendee_count</code></td>          <td>Hidden</td>   <td>Integer count of attendees</td></tr>
          <tr><td><code>rv_amp</code></td>                  <td><code>rv_amp</code></td>                  <td>Hidden</td>   <td>Required only when <code>lodging_option_key = rv_hookups</code></td></tr>
          <tr><td><code>rv_length</code></td>               <td><code>rv_length</code></td>               <td>Hidden</td>   <td>Required only when <code>lodging_option_key = rv_hookups</code></td></tr>
          <tr><td><code>registration_total</code></td>      <td><code>registration_total</code></td>      <td>Hidden</td>   <td>Total before processing fee. Volunteers stay in the roster but do not increase this total.</td></tr>
          <tr><td><code>processing_fee</code></td>          <td><code>processing_fee</code></td>          <td>Hidden</td>   <td>Square fee from the widget. Must be <code>0.00</code> for offline/check/cash flows.</td></tr>
          <tr><td><code>payment_method</code></td>          <td><code>payment_method</code></td>          <td>Hidden</td>   <td><code>square</code> or <code>offline</code> as stored by the widget</td></tr>
          <tr><td><code>notes</code></td>                   <td><code>notes</code></td>                   <td>Textarea</td> <td>General registration notes</td></tr>
          <tr><td><code>medical_notes</code></td>           <td><code>medical_notes</code></td>           <td>Textarea</td> <td>Medical/disclosure notes when supplied</td></tr>
          <tr><td><code>attendees_json</code></td>          <td><code>attendees_json</code></td>          <td>Hidden</td>   <td>Legacy mirror of <code>people_json</code> retained for compatibility</td></tr>
        </tbody>
      </table>
      <p style="color:#646970;font-size:12px;margin-top:10px;">The live form uses a custom JavaScript builder rendered into <code>#mancamp-builder</code>. This plugin expects the hidden-field contract above and waits until Fluent Forms marks payment complete before posting to GAS.</p>
    </div>


    <!-- ── Manual Resync ─────────────────────────────────────────────── -->
    <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:24px;margin-bottom:24px;">
      <h2 style="margin-top:0;">Manual Resync</h2>
      <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
        <?php wp_nonce_field( 'mancamp_manual_resync', 'mancamp_manual_nonce' ); ?>
        <input type="hidden" name="action" value="mancamp_manual_resync">
        <p>
          <label for="ff_entry_id"><strong>Fluent Forms Entry ID:</strong></label><br>
          <input type="number" id="ff_entry_id" name="mancamp_manual_entry_id" min="1" style="width:140px;" required>
          <button type="submit" class="button button-primary" style="margin-left:8px;">Re-send to GAS</button>
        </p>
        <p style="color:#646970;font-size:12px;">
          Re-sends a specific submission to GAS. GAS will reject it silently if already processed (duplicate guard).
        </p>
      </form>
    </div>


    <!-- ── Failed Submissions ────────────────────────────────────────── -->
    <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:24px;margin-bottom:24px;">
      <h2 style="margin-top:0;">
        Pending Failed Webhooks
        <?php if ( ! empty( $failed_entries ) ) : ?>
          <span style="background:#d63638;color:#fff;padding:2px 9px;border-radius:10px;font-size:13px;vertical-align:middle;margin-left:6px;">
            <?php echo count( $failed_entries ); ?>
          </span>
        <?php endif; ?>
      </h2>
      <p><strong>Pending Failed Webhooks:</strong> <?php echo (int) count( $failed_entries ); ?></p>
      <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="margin-bottom:16px;">
        <?php wp_nonce_field( 'mancamp_retry', 'mancamp_retry_nonce' ); ?>
        <input type="hidden" name="action" value="mancamp_retry">
        <input type="hidden" name="mancamp_retry_entry_id" value="0">
        <button type="submit" class="button">Manual Retry Pending Webhooks</button>
      </form>
      <?php if ( empty( $failed_entries ) ) : ?>
        <p style="color:green;">✔ No failed webhooks are pending.</p>
      <?php else : ?>
        <table class="widefat striped">
          <thead>
            <tr><th>FF Entry</th><th>Registrant</th><th>Email</th><th>Failed At</th><th>Attempts</th><th></th></tr>
          </thead>
          <tbody>
            <?php foreach ( $failed_entries as $entry ) :
              $p = $entry['payload'] ?? [];
            ?>
            <tr>
              <td><?php echo esc_html( $entry['entry_id'] ?? '—' ); ?></td>
              <td><?php echo esc_html( $p['primaryContact']['name']  ?? $p['registrantName'] ?? $p['registrationLabel'] ?? '—' ); ?></td>
              <td><?php echo esc_html( $p['primaryContact']['email'] ?? $p['registrantEmail'] ?? $p['email'] ?? '—' ); ?></td>
              <td><?php echo esc_html( $entry['failed_at']   ?? '—' ); ?></td>
              <td><?php echo esc_html( $entry['attempts'] ?? 1 ); ?></td>
              <td>
                <form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
                  <?php wp_nonce_field( 'mancamp_retry', 'mancamp_retry_nonce' ); ?>
                  <input type="hidden" name="action" value="mancamp_retry">
                  <input type="hidden" name="mancamp_retry_entry_id" value="<?php echo esc_attr( $entry['entry_id'] ?? 0 ); ?>">
                  <button type="submit" class="button button-small button-primary">Retry</button>
                </form>
              </td>
            </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      <?php endif; ?>
    </div>


    <!-- ── Webhook Log ──────────────────────────────────────────── -->
    <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:24px;">
      <h2 style="margin-top:0;">View Webhook Log <span style="color:#646970;font-size:13px;font-weight:400;">(last 50)</span></h2>
      <?php if ( empty( $webhook_log ) ) : ?>
        <p>No webhook activity logged yet.</p>
      <?php else : ?>
        <table class="widefat striped" style="max-width:700px;">
          <thead><tr><th>Timestamp</th><th>FF Entry ID</th><th>Status</th><th>Message</th></tr></thead>
          <tbody>
            <?php foreach ( $webhook_log as $entry ) : ?>
            <tr>
              <td><?php echo esc_html( $entry['timestamp'] ?? '—' ); ?></td>
              <td><?php echo esc_html( $entry['entry_id'] ?? '—' ); ?></td>
              <td><code><?php echo esc_html( $entry['status'] ?? '—' ); ?></code></td>
              <td><?php echo esc_html( $entry['message'] ?? '—' ); ?></td>
            </tr>
            <?php endforeach; ?>
          </tbody>
        </table>
      <?php endif; ?>
    </div>

    </div><!-- /.wrap -->
    <?php
}


// ============================================================
// SECTION 13 — LOGGING
// ============================================================

function mancamp_log( $message, $level = 'info' ) {
    if ( ! mancamp_debug() && $level === 'info' ) return;
    error_log( '[ManCamp][' . strtoupper( $level ) . '] ' . $message );
}

function mancamp_log_event( $entry_id, $status, $message, $force_error_log = false ) {
    $log = get_option( MANCAMP_WEBHOOK_LOG_OPTION, [] );
    $log[] = [
        'timestamp' => current_time( 'mysql' ),
        'entry_id'  => (int) $entry_id,
        'status'    => sanitize_key( $status ),
        'message'   => sanitize_text_field( $message ),
    ];

    if ( count( $log ) > 50 ) {
        $log = array_slice( $log, -50 );
    }

    update_option( MANCAMP_WEBHOOK_LOG_OPTION, $log, false );

    if ( $force_error_log || mancamp_debug() ) {
        mancamp_log( '[entry ' . (int) $entry_id . '][' . $status . '] ' . $message, $status === 'failed' ? 'error' : 'info' );
    }
}

function mancamp_has_sent_entry_id( $entry_id ) {
    $records = get_option( MANCAMP_SENT_ENTRY_IDS_OPTION, [] );
    foreach ( $records as $record ) {
        if ( (int) ( $record['entry_id'] ?? 0 ) === (int) $entry_id ) {
            return true;
        }
    }
    return false;
}

function mancamp_mark_entry_sent( $entry_id ) {
    $records = get_option( MANCAMP_SENT_ENTRY_IDS_OPTION, [] );
    $records[] = [
        'entry_id' => (int) $entry_id,
        'sent_at'  => current_time( 'mysql' ),
    ];
    update_option( MANCAMP_SENT_ENTRY_IDS_OPTION, array_values( $records ), false );
    mancamp_prune_sent_entry_ids();
}

function mancamp_prune_sent_entry_ids() {
    $records = get_option( MANCAMP_SENT_ENTRY_IDS_OPTION, [] );
    if ( empty( $records ) ) {
        return;
    }

    $cutoff = time() - ( 30 * DAY_IN_SECONDS );
    $records = array_values( array_filter( $records, static function ( $record ) use ( $cutoff ) {
        $sent_at = isset( $record['sent_at'] ) ? strtotime( $record['sent_at'] ) : false;
        return ! $sent_at || $sent_at >= $cutoff;
    } ) );

    update_option( MANCAMP_SENT_ENTRY_IDS_OPTION, $records, false );
}

function mancamp_resolve_payment_hook_context( $args ) {
    $entry_id = 0;
    $form_id = 0;
    $submission = [];
    $payment = [];
    $numeric_args = [];

    foreach ( $args as $arg ) {
        if ( is_numeric( $arg ) ) {
            $numeric_args[] = (int) $arg;
            continue;
        }

        if ( is_object( $arg ) ) {
            $arg = get_object_vars( $arg );
        }

        if ( ! is_array( $arg ) ) {
            continue;
        }

        if ( ! $entry_id ) {
            $entry_id = (int) ( $arg['submission_id'] ?? $arg['entry_id'] ?? $arg['id'] ?? 0 );
        }

        if ( ! $form_id ) {
            $form_id = (int) ( $arg['form_id'] ?? 0 );
        }

        if ( isset( $arg['response'] ) || isset( $arg['created_at'] ) ) {
            $submission = $arg;
        }

        if ( isset( $arg['payment_status'] ) || isset( $arg['transaction_id'] ) || isset( $arg['payment_total'] ) ) {
            $payment = array_merge( $payment, $arg );
        }
    }

    if ( ! $entry_id && ! empty( $numeric_args ) ) {
        $entry_id = (int) end( $numeric_args );
    }

    if ( ! $entry_id ) {
        return new WP_Error( 'missing_entry_id', 'Could not resolve entry_id from Fluent Forms payment hook arguments.' );
    }

    if ( empty( $submission ) ) {
        $submission = mancamp_get_submission_record( $entry_id );
        if ( is_wp_error( $submission ) ) {
            return $submission;
        }
    }

    if ( ! $form_id ) {
        $form_id = (int) ( $submission['form_id'] ?? 0 );
    }

    if ( empty( $payment ) ) {
        $payment = mancamp_get_payment_record( $entry_id );
    }

    return [
        'entry_id'   => $entry_id,
        'form_id'    => $form_id,
        'submission' => $submission,
        'payment'    => is_array( $payment ) ? $payment : [],
    ];
}

function mancamp_get_submission_record( $entry_id ) {
    global $wpdb;

    $table = $wpdb->prefix . 'fluentform_submissions';
    $row = $wpdb->get_row(
        $wpdb->prepare( "SELECT * FROM {$table} WHERE id = %d LIMIT 1", $entry_id ),
        ARRAY_A
    );

    if ( ! $row ) {
        return new WP_Error( 'submission_not_found', 'Fluent Forms submission was not found.' );
    }

    $response = [];
    if ( ! empty( $row['response'] ) ) {
        $decoded = json_decode( $row['response'], true );
        if ( is_array( $decoded ) ) {
            $response = $decoded;
        }
    }
    $row['response'] = $response;

    return $row;
}

function mancamp_get_payment_record( $entry_id ) {
    global $wpdb;

    $table = $wpdb->prefix . 'fluentform_transactions';
    $exists = $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) );
    if ( $exists !== $table ) {
        return [];
    }

    $row = $wpdb->get_row(
        $wpdb->prepare( "SELECT * FROM {$table} WHERE submission_id = %d ORDER BY id DESC LIMIT 1", $entry_id ),
        ARRAY_A
    );

    return is_array( $row ) ? $row : [];
}

function mancamp_normalise_submission_argument( $submission, $entry_id = 0 ) {
    if ( is_object( $submission ) ) {
        $submission = get_object_vars( $submission );
    }

    if ( ! is_array( $submission ) || empty( $submission ) ) {
        return mancamp_get_submission_record( $entry_id );
    }

    if ( ! isset( $submission['id'] ) && $entry_id > 0 ) {
        $submission['id'] = $entry_id;
    }

    if ( isset( $submission['response'] ) && is_string( $submission['response'] ) ) {
        $decoded = json_decode( $submission['response'], true );
        $submission['response'] = is_array( $decoded ) ? $decoded : [];
    } elseif ( ! isset( $submission['response'] ) ) {
        $submission['response'] = [];
    }

    return $submission;
}

function mancamp_is_offline_submission( $submission, $payment = [] ) {
    $submission = mancamp_normalise_submission_argument( $submission, 0 );
    if ( is_wp_error( $submission ) ) {
        return false;
    }

    $form_data = is_array( $submission['response'] ?? null ) ? $submission['response'] : [];
    $method = mancamp_normalise_pay_type(
        $payment['payment_method'] ?? $payment['payment_mode'] ?? $payment['method'] ?? mancamp_pick_field( $form_data, [ 'mc_payment_method_out', 'payment_method', 'pay_type' ], 'square' )
    );

    return $method === 'offline';
}


// ============================================================
// SECTION 14 — ACTIVATION / DEACTIVATION
// ============================================================

register_activation_hook( __FILE__, 'mancamp_activate' );

function mancamp_activate() {
    if ( ! function_exists( 'wpFluentForm' ) && ! defined( 'FLUENTFORM' ) ) {
        deactivate_plugins( plugin_basename( __FILE__ ) );
        wp_die( 'Man Camp Registration requires Fluent Forms Pro.', 'Plugin Dependency Error', [ 'back_link' => true ] );
    }
    add_option( MANCAMP_OPTION_GROUP, [
        'gas_url'    => '',
        'form_id'    => 0,
        'page_slug'  => 'man-camp-registration',
        'debug_mode' => false,
    ] );
    add_option( MANCAMP_FAILED_WEBHOOKS_OPTION, [] );
    add_option( MANCAMP_SENT_ENTRY_IDS_OPTION, [] );
    add_option( MANCAMP_WEBHOOK_LOG_OPTION, [] );
    add_option( MANCAMP_OFFLINE_SWEEP_STATUS_OPTION, [
        'last_run' => '',
        'processed_count' => 0,
    ] );
    mancamp_schedule_retry_event();
    mancamp_schedule_offline_sweep_event();
}

register_deactivation_hook( __FILE__, 'mancamp_deactivate' );

function mancamp_deactivate() {
    // Options and transients preserved intentionally for re-activation
    wp_clear_scheduled_hook( MANCAMP_RETRY_HOOK );
    wp_clear_scheduled_hook( MANCAMP_OFFLINE_SWEEP_HOOK );
}
