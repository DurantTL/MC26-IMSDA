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
define( 'MANCAMP_RETRY_HOOK', 'mancamp_retry_webhooks' );

function mancamp_get_setting( $key, $default = '' ) {
    $options = get_option( MANCAMP_OPTION_GROUP, [] );
    return isset( $options[ $key ] ) ? $options[ $key ] : $default;
}

function mancamp_gas_url()   { return mancamp_get_setting( 'gas_url',    '' ); }
function mancamp_form_id()   { return (int) mancamp_get_setting( 'form_id',   0 ); }
function mancamp_page_slug() { return mancamp_get_setting( 'page_slug',  'man-camp-registration' ); }
function mancamp_debug()     { return (bool) mancamp_get_setting( 'debug_mode', false ); }


// ============================================================
// SECTION 2 — FIELD MAP
// ============================================================

const MANCAMP_FIELD_MAP = [
    'first_name'              => 'first_name',
    'last_name'               => 'last_name',
    'email'                   => 'email',
    'phone'                   => 'phone',
    'age'                     => 'age',
    'ageNum'                  => 'age',
    'pay_type'                => 'pay_type',
    'lodging_option_key'      => 'lodging_option_key',
    'lodging_option_label'    => 'lodging_option_label',
    'lodging_request_json'    => 'lodging_request_json',
    'rv_amp'                  => 'rv_amp',
    'rv_length'               => 'rv_length',
    'people_json'             => 'people_json',
    'attendees_json'          => 'people_json',
    'roster_json'             => 'roster_json',
    'attendee_count'          => 'attendee_count',
    'registration_total'      => 'registration_total',
    'processing_fee'          => 'processing_fee',
    'custom_payment_amount'   => 'custom_payment_amount',
    'payment_status'          => 'payment_status',
    'payment_reference'       => 'payment_reference',
    'payment_method'          => 'payment_method',
    'square_total'            => 'square_total',
    'amount_paid'             => 'amount_paid',
    'notes'                   => 'notes',
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
    add_action( 'fluentform_submission_inserted',     'mancamp_handle_submission', 20, 3 );
    add_action( MANCAMP_RETRY_HOOK, 'mancamp_retry_failed_webhooks' );
    add_filter( 'cron_schedules', 'mancamp_add_cron_schedule' );
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
        'gasUrl' => mancamp_gas_url(),
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
    $current = trim( parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH ), '/' );
    return ( $current === $slug || substr( $current, -strlen( $slug ) ) === $slug );
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
// SECTION 6 — SUBMISSION HANDLER
// ============================================================

function mancamp_handle_submission( $insertId, $formData, $form ) {
    if ( (int) $form->id !== mancamp_form_id() ) return;

    mancamp_log( 'Submission received. FF entry ID: ' . $insertId );

    $payload = mancamp_build_payload( $formData, $insertId );

    if ( is_wp_error( $payload ) ) {
        mancamp_log( 'Payload build error: ' . $payload->get_error_message(), 'error' );
        return;
    }

    update_option( 'mancamp_pending_' . $insertId, $payload, false );

    $result = mancamp_post_to_gas( $payload );

    if ( is_wp_error( $result ) ) {
        mancamp_log( 'GAS POST error: ' . $result->get_error_message(), 'error' );
        mancamp_store_failed_payload( $insertId, $payload, $result->get_error_message() );
        return;
    }

    delete_option( 'mancamp_pending_' . $insertId );
    mancamp_remove_failed_payload( $insertId );
    mancamp_log( 'GAS response: ' . wp_json_encode( $result ) );

    if ( ! empty( $result['registrationId'] ) ) {
        $log   = get_option( 'mancamp_id_log', [] );
        $log[] = [
            'ff_entry_id'     => $insertId,
            'registration_id' => $result['registrationId'],
            'timestamp'       => current_time( 'mysql' ),
        ];
        if ( count( $log ) > 500 ) $log = array_slice( $log, -500 );
        update_option( 'mancamp_id_log', $log, false );
    }
}


// ============================================================
// SECTION 7 — PAYLOAD BUILDER
// ============================================================

function mancamp_build_payload( $formData, $insertId ) {
    $top_level = [];

    foreach ( MANCAMP_FIELD_MAP as $ff_key => $gas_key ) {
        if ( ! isset( $formData[ $ff_key ] ) ) continue;
        $top_level[ $gas_key ] = mancamp_sanitise_top_level_field( $ff_key, $formData[ $ff_key ] );
    }

    $people = mancamp_extract_people_payload( $formData );
    if ( is_wp_error( $people ) ) {
        return $people;
    }

    $primary = $people[0];
    $lodging_request = mancamp_extract_lodging_request( $formData, $primary );
    $payment = mancamp_collect_payment_meta( $formData, $top_level );
    $people_json = wp_json_encode( $people );
    $submitted_at = current_time( 'c' );

    return [
        'action'            => 'submitRegistration',
        'eventKey'          => MANCAMP_EVENT_KEY,
        'fluentFormEntryId' => (string) $insertId,
        'submittedAt'       => $submitted_at,
        'primaryContact'    => [
            'name'  => trim( $primary['first_name'] . ' ' . $primary['last_name'] ),
            'email' => $primary['email'],
            'phone' => $primary['phone'],
        ],
        'lodgingRequest'    => $lodging_request,
        'people'            => $people,
        'attendeeCount'     => count( $people ),
        'payment'           => $payment,

        // Legacy aliases retained for the existing GAS normalization paths.
        'first_name'            => $primary['first_name'],
        'last_name'             => $primary['last_name'],
        'email'                 => $primary['email'],
        'phone'                 => $primary['phone'],
        'age'                   => $primary['age'],
        'ageNum'                => $primary['age'],
        'lodging_option_key'    => $lodging_request['type'],
        'lodging_option_label'  => mancamp_lodging_label( $lodging_request['type'] ),
        'lodging_request_json'  => wp_json_encode( $lodging_request ),
        'rv_amp'                => $lodging_request['rvAmp'] === null ? '' : $lodging_request['rvAmp'],
        'rv_length'             => $lodging_request['rvLengthFeet'] === null ? '' : $lodging_request['rvLengthFeet'],
        'people_json'           => $people_json,
        'attendees_json'        => $people_json,
        'roster_json'           => $people_json,
        'attendee_count'        => count( $people ),
        'registration_total'    => $payment['registrationTotal'],
        'processing_fee'        => $payment['processingFee'],
        'custom_payment_amount' => $payment['amountPaid'],
        'payment_method'        => $payment['method'],
        'pay_type'              => $payment['method'],
        'payment_status'        => $payment['status'],
        'payment_reference'     => $payment['reference'],
        'amount_paid'           => $payment['amountPaid'],
        'square_total'          => $payment['amountPaid'],
        'attendees'             => $people,
        'roster'                => $people,
        'notes'                 => sanitize_textarea_field( $top_level['notes'] ?? '' ),
    ];
}


// ============================================================
// SECTION 8 — ATTENDEE SANITISERS
// ============================================================

function mancamp_extract_people_payload( $formData ) {
    $people_raw = mancamp_pick_field( $formData, [ 'people_json', 'attendees_json', 'attendeesJson', 'roster_json' ], '' );

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
            'program'                  => sanitize_text_field( $raw['program'] ?? $raw['program_type'] ?? $raw['programType'] ?? $default_program ),
            'shirt'                    => strtoupper( sanitize_text_field( $raw['shirt'] ?? $raw['shirt_size'] ?? $raw['shirtSize'] ?? $default_shirt ) ),
            'volunteer'                => mancamp_normalise_yes_no( $raw['volunteer'] ?? 'no' ),
            'attendance_type'          => mancamp_normalise_attendance_type( $raw['attendance_type'] ?? $raw['attendanceType'] ?? 'overnight' ),
            'guardian_link_key'        => sanitize_text_field( $raw['guardian_link_key'] ?? $raw['guardianLinkKey'] ?? '' ),
            'is_primary'               => ! empty( $raw['is_primary'] ) || ! empty( $raw['isPrimary'] ) || $idx === 0,
            'lodging_option_key'       => $lodging_option_key,
            'notes'                    => $notes,
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
        'program'                  => sanitize_text_field( $formData['program_type'] ?? $formData['program'] ?? 'standard' ),
        'shirt'                    => strtoupper( sanitize_text_field( $formData['shirt_size'] ?? $formData['shirt'] ?? '' ) ),
        'volunteer'                => 'no',
        'attendance_type'          => mancamp_normalise_attendance_type( $formData['attendance_type'] ?? 'overnight' ),
        'is_guardian'              => false,
        'guardian_link_key'        => sanitize_text_field( $formData['guardian_link_key'] ?? '' ),
        'is_primary'               => true,
        'lodging_option_key'       => mancamp_normalise_lodging_preference( $formData['lodging_option_key'] ?? $formData['lodging_preference'] ?? '' ),
        'notes'                    => sanitize_textarea_field( $formData['notes'] ?? '' ),
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

    if ( in_array( $field_key, [ 'ageNum', 'age', 'registration_total', 'processing_fee', 'custom_payment_amount', 'square_total', 'amount_paid', 'attendee_count', 'rv_length' ], true ) ) {
        return is_numeric( $raw ) ? 0 + $raw : '';
    }

    if ( $field_key === 'lodging_option_key' ) {
        return mancamp_normalise_lodging_preference( $raw );
    }

    if ( $field_key === 'pay_type' || $field_key === 'payment_method' ) {
        return mancamp_normalise_pay_type( $raw );
    }

    return $field_key === 'notes'
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

    return $normalised;
}

function mancamp_normalise_pay_type( $value ) {
    $normalised = strtolower( sanitize_text_field( (string) $value ) );
    if ( in_array( $normalised, [ 'offline', 'check', 'cash' ], true ) ) {
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

function mancamp_collect_payment_meta( $formData, $top_level = [] ) {
    $method = mancamp_normalise_pay_type(
        mancamp_pick_field( $formData, [ 'payment_method', 'paymentMethod', 'pay_type' ], $top_level['payment_method'] ?? 'square' )
    );
    $payment_status = strtolower( sanitize_text_field(
        mancamp_pick_field( $formData, [ 'payment_status', 'paymentStatus', 'payment-status', 'payment_status_field', 'payment' ], '' )
    ) );
    $payment_reference = sanitize_text_field(
        mancamp_pick_field( $formData, [ 'payment_reference', 'paymentReference', 'transaction_id', 'transactionId', 'order_id', 'orderId', 'square_payment_id' ], '' )
    );
    $registration_total = mancamp_format_money(
        mancamp_pick_field( $formData, [ 'registration_total' ], $top_level['registration_total'] ?? 0 )
    );
    $processing_fee = $method === 'square'
        ? mancamp_format_money( mancamp_pick_field( $formData, [ 'processing_fee' ], $top_level['processing_fee'] ?? 0 ) )
        : mancamp_format_money( 0 );
    $amount_paid_raw = mancamp_pick_field( $formData, [ 'amount_paid', 'total_paid', 'square_total', 'custom_payment_amount', 'custom-payment-amount' ], $top_level['custom_payment_amount'] ?? 0 );
    $amount_paid = $amount_paid_raw !== '' ? mancamp_format_money( $amount_paid_raw ) : mancamp_format_money( (float) $registration_total + (float) $processing_fee );
    $status = $payment_status !== '' ? $payment_status : ( $method === 'square' ? 'paid' : 'unpaid' );

    return [
        'method'            => $method,
        'status'            => $status,
        'reference'         => $payment_reference,
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
    mancamp_log( 'GAS body — ' . substr( $response_body, 0, 500 ) );

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
            mancamp_log( 'GAS duplicate — skipping.' );
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

function mancamp_store_failed_payload( $insertId, $payload, $error ) {
    $failed = get_option( MANCAMP_FAILED_WEBHOOKS_OPTION, [] );
    $updated = false;

    foreach ( $failed as &$entry ) {
        if ( (int) ( $entry['entry_id'] ?? 0 ) !== (int) $insertId ) {
            continue;
        }
        $entry['payload'] = $payload;
        $entry['error'] = $error;
        $entry['failed_at'] = $entry['failed_at'] ?? current_time( 'mysql' );
        $entry['attempts'] = isset( $entry['attempts'] ) ? (int) $entry['attempts'] : 1;
        $updated = true;
        break;
    }
    unset( $entry );

    if ( ! $updated ) {
        $failed[] = [
            'entry_id'  => (int) $insertId,
            'payload'   => $payload,
            'error'     => $error,
            'failed_at' => current_time( 'mysql' ),
            'attempts'  => 1,
        ];
    }

    update_option( MANCAMP_FAILED_WEBHOOKS_OPTION, array_values( $failed ), false );
    mancamp_schedule_retry_event();
    mancamp_log( 'Failed payload stored for entry ' . $insertId, 'error' );
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
    return $schedules;
}

function mancamp_schedule_retry_event() {
    if ( ! wp_next_scheduled( MANCAMP_RETRY_HOOK ) ) {
        wp_schedule_event( time() + ( 15 * MINUTE_IN_SECONDS ), 'mancamp_every_15_minutes', MANCAMP_RETRY_HOOK );
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

        $result = mancamp_post_to_gas( $entry['payload'] ?? [] );
        if ( is_wp_error( $result ) ) {
            $entry['attempts'] = $attempts + 1;
            $entry['error'] = $result->get_error_message();
            $remaining[] = $entry;
            continue;
        }

        delete_option( 'mancamp_pending_' . (int) ( $entry['entry_id'] ?? 0 ) );
    }

    update_option( MANCAMP_FAILED_WEBHOOKS_OPTION, array_values( $remaining ), false );
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
        'gas_url'    => esc_url_raw( trim( $_POST['gas_url']   ?? '' ) ),
        'form_id'    => (int) ( $_POST['form_id']   ?? 0 ),
        'page_slug'  => trim( sanitize_text_field( $_POST['page_slug'] ?? '' ), '/' ),
        'debug_mode' => isset( $_POST['debug_mode'] ),
    ] );

    wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&saved=1' ) );
    exit;
}

function mancamp_handle_retry() {
    if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Insufficient permissions.' );
    check_admin_referer( 'mancamp_retry', 'mancamp_retry_nonce' );

    $entry_id = (int) ( $_POST['mancamp_retry_entry_id'] ?? 0 );
    $failed = get_option( MANCAMP_FAILED_WEBHOOKS_OPTION, [] );
    $entry = null;
    foreach ( $failed as $candidate ) {
        if ( (int) ( $candidate['entry_id'] ?? 0 ) === $entry_id ) {
            $entry = $candidate;
            break;
        }
    }

    if ( $entry && is_array( $entry ) ) {
        $result = mancamp_post_to_gas( $entry['payload'] );
        if ( is_wp_error( $result ) ) {
            wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&retry_failed=' . urlencode( $result->get_error_message() ) ) );
        } else {
            delete_option( 'mancamp_pending_' . $entry_id );
            mancamp_remove_failed_payload( $entry_id );
            if ( ! empty( $result['duplicate'] ) ) {
                wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&retry_ok=' . urlencode( 'already-processed' ) ) );
            } else {
                wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&retry_ok=' . urlencode( $result['registrationId'] ?? 'sent' ) ) );
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
            $submission = wpFluentForm()->make( 'FluentForm\App\Models\Submission' )->find( $ff_entry_id );
            if ( $submission ) {
                mancamp_handle_submission( $ff_entry_id, json_decode( $submission->response, true ), (object) [ 'id' => mancamp_form_id() ] );
                wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&resync_ok=' . $ff_entry_id ) );
                exit;
            }
        } catch ( Exception $e ) {
            wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&resync_failed=' . urlencode( $e->getMessage() ) ) );
            exit;
        }
    }

    wp_redirect( admin_url( 'options-general.php?page=mancamp-registration&resync_failed=' . urlencode( 'Entry not found.' ) ) );
    exit;
}


// ============================================================
// SECTION 12 — ADMIN PAGE RENDER
// ============================================================

function mancamp_admin_page() {
    if ( ! current_user_can( 'manage_options' ) ) wp_die( 'Insufficient permissions.' );

    $gas_url    = mancamp_gas_url();
    $form_id    = mancamp_form_id();
    $page_slug  = mancamp_page_slug();
    $debug_mode = mancamp_debug();

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

    $failed_entries = get_option( MANCAMP_FAILED_WEBHOOKS_OPTION, [] );

    $log = array_reverse( array_slice( get_option( 'mancamp_id_log', [] ), -20 ) );

    ?>
    <div class="wrap" style="max-width:900px;">
    <h1>Man Camp Registration Settings</h1>

    <?php if ( $saved ) : ?>
      <div class="notice notice-success is-dismissible"><p>✔ Settings saved.</p></div>
    <?php endif; ?>
    <?php if ( $retry_ok ) : ?>
      <?php if ( $retry_ok === 'already-processed' ) : ?>
        <div class="notice notice-success is-dismissible"><p>✔ Already processed — this registration was received by GAS on the original submission. The failed entry has been cleared.</p></div>
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
      <h2 style="margin-top:0;">Fluent Forms Field Name Reference <span style="color:#646970;font-size:13px;font-weight:400;">(v2.2.0)</span></h2>
      <p style="color:#646970;font-size:13px;">These are the preferred Fluent Forms field names for the Man Camp form. Use them as the field <strong>Name</strong> values in the form builder.</p>
      <table class="widefat striped" style="font-size:12px;">
        <thead><tr><th>FF Field Name</th><th>GAS Key</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>first_name</code></td>              <td><code>first_name</code></td>              <td>Text</td>     <td>Primary registrant first name</td></tr>
          <tr><td><code>last_name</code></td>               <td><code>last_name</code></td>               <td>Text</td>     <td>Primary registrant last name</td></tr>
          <tr><td><code>email</code></td>                   <td><code>email</code></td>                   <td>Email</td>    <td>Primary contact email</td></tr>
          <tr><td><code>phone</code></td>                   <td><code>phone</code></td>                   <td>Phone</td>    <td>Primary contact phone</td></tr>
          <tr><td><code>ageNum</code></td>                  <td><code>ageNum</code></td>                  <td>Number</td>   <td>Primary registrant age used for minor and Young Men&#8217;s validation</td></tr>
          <tr><td><code>pay_type</code></td>                <td><code>pay_type</code></td>                <td>Select</td>   <td>Application-level payment selector. Use <code>square</code> or <code>offline</code>. Do not use <code>payment_method</code> for this decision.</td></tr>
          <tr><td><code>lodging_option_key</code></td>      <td><code>lodging_option_key</code></td>      <td>Hidden</td>   <td><code>cabin_connected</code>, <code>cabin_detached</code>, <code>rv_hookups</code>, <code>tent_no_hookups</code>, <code>sabbath_only</code></td></tr>
          <tr><td><code>rv_amp</code></td>                  <td><code>rv_amp</code></td>                  <td>Hidden</td>   <td>Required only when <code>lodging_option_key = rv_hookups</code></td></tr>
          <tr><td><code>rv_length</code></td>               <td><code>rv_length</code></td>               <td>Hidden</td>   <td>Required only when <code>lodging_option_key = rv_hookups</code></td></tr>
          <tr><td><code>registration_total</code></td>      <td><code>registration_total</code></td>      <td>Hidden</td>   <td>Total before processing fee. Volunteers stay in the roster but do not increase this total.</td></tr>
          <tr><td><code>processing_fee</code></td>          <td><code>processing_fee</code></td>          <td>Hidden</td>   <td>Square fee from the widget. Must be <code>0</code> when <code>pay_type = offline</code>.</td></tr>
          <tr><td><code>custom_payment_amount</code></td>   <td><code>custom_payment_amount</code></td>   <td>Square</td>   <td>Final amount charged by Fluent Forms Square. Frontend may also write <code>custom-payment-amount</code> in the DOM for compatibility.</td></tr>
          <tr><td><code>payment_status</code></td>          <td><code>payment_status</code></td>          <td>Hidden</td>   <td>Capture Square / Fluent Forms payment status when available</td></tr>
          <tr><td><code>payment_reference</code></td>       <td><code>payment_reference</code></td>       <td>Hidden</td>   <td>Square order / transaction reference when available</td></tr>
          <tr><td><code>notes</code></td>                   <td><code>notes</code></td>                   <td>Textarea</td> <td>General registration notes</td></tr>
          <tr><td><code>attendees_json</code></td>          <td><code>attendees_json</code></td>          <td>Hidden</td>   <td>Canonical attendee roster written by the custom widget</td></tr>
          <tr><td><code>roster_json</code></td>             <td><code>roster</code></td>                  <td>Hidden</td>   <td>Optional legacy mirror only. New code should use <code>attendees_json</code>.</td></tr>
        </tbody>
      </table>
      <p style="color:#646970;font-size:12px;margin-top:10px;">The live form uses a custom JavaScript builder rendered into <code>#mancamp-builder</code>. This plugin now expects the hidden-field contract above rather than repeater rows or payment-item fields.</p>
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
        Failed Submissions
        <?php if ( ! empty( $failed_entries ) ) : ?>
          <span style="background:#d63638;color:#fff;padding:2px 9px;border-radius:10px;font-size:13px;vertical-align:middle;margin-left:6px;">
            <?php echo count( $failed_entries ); ?>
          </span>
        <?php endif; ?>
      </h2>
      <?php if ( empty( $failed_entries ) ) : ?>
        <p style="color:green;">✔ No failed submissions. All registrations reached GAS.</p>
      <?php else : ?>
        <table class="widefat striped">
          <thead>
            <tr><th>FF Entry</th><th>Registrant</th><th>Email</th><th>Failed At</th><th>Error</th><th></th></tr>
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
              <td style="font-size:12px;max-width:200px;word-break:break-word;"><?php echo esc_html( $entry['error'] ?? '—' ); ?></td>
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


    <!-- ── Recent Successes ──────────────────────────────────────────── -->
    <div style="background:#fff;border:1px solid #c3c4c7;border-radius:4px;padding:24px;">
      <h2 style="margin-top:0;">Recent Successful Registrations <span style="color:#646970;font-size:13px;font-weight:400;">(last 20)</span></h2>
      <?php if ( empty( $log ) ) : ?>
        <p>No registrations logged yet.</p>
      <?php else : ?>
        <table class="widefat striped" style="max-width:700px;">
          <thead><tr><th>FF Entry ID</th><th>GAS Registration ID</th><th>Timestamp</th></tr></thead>
          <tbody>
            <?php foreach ( $log as $entry ) : ?>
            <tr>
              <td><?php echo esc_html( $entry['ff_entry_id']     ?? '—' ); ?></td>
              <td><code><?php echo esc_html( $entry['registration_id'] ?? '—' ); ?></code></td>
              <td><?php echo esc_html( $entry['timestamp']       ?? '—' ); ?></td>
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
    add_option( 'mancamp_id_log',      [] );
    mancamp_schedule_retry_event();
}

register_deactivation_hook( __FILE__, 'mancamp_deactivate' );

function mancamp_deactivate() {
    // Options and transients preserved intentionally for re-activation
    wp_clear_scheduled_hook( MANCAMP_RETRY_HOOK );
}
