/// `GET /profiling/form` for a CNC turner as the deployed API (f455bb36)
/// serves it: the trade pack's own questions, then all eight `qp_universal@2`
/// questions appended to the capability section, then the preferences,
/// employment and qualifications markers. Answer types are the server's
/// aliased ones (city → text, salary/duration → number), which is why the
/// worker saw a plain text box for "Aap kahaan kaam karna chahte hain?".
///
/// Shared by the repository and screen tests; not a test file itself.
library;

const String kUniversalPreferredCityPrompt =
    'Aap kahaan kaam karna chahte hain?';
const String kUniversalCurrentCityPrompt = 'Abhi aap kaunse sheher mein hain?';
const String kUniversalAvailabilityPrompt =
    'Aap kaam kab se shuru kar sakte hain?';

/// The universal question keys in the order the server appends them.
const List<String> kUniversalQuestionKeys = <String>[
  'primary_trade',
  'experience_years',
  'current_city',
  'salary_expected',
  'preferred_locations',
  'availability',
  'education',
  'shift_preference',
];

Map<String, dynamic> _question(
  String key,
  String prompt,
  String answerType, {
  List<List<String>> options = const <List<String>>[],
}) =>
    <String, dynamic>{
      'type': 'question',
      'question': <String, dynamic>{
        'question_key': key,
        'prompt_text': prompt,
        'why_text': null,
        'answer_type': answerType,
        'options': <dynamic>[
          for (final List<String> o in options)
            <String, dynamic>{
              'option_key': o[0],
              'label_text': o[1],
              'is_none_of_above': false,
            },
        ],
      },
      'ui': <String, dynamic>{'searchable': false},
      'answer': null,
      'suggestion': null,
    };

Map<String, dynamic> universalAppendedFormJson() => <String, dynamic>{
      'kind': 'cnc_turner',
      'pack_id': 'qp_cnc_turning',
      'pack_version': 1,
      'session_id': '8f7c2a8e-3b7e-4c61-9a57-2f1d0b6c9e11',
      'sections': <dynamic>[
        <String, dynamic>{
          'id': 'capability',
          'title': 'Machines, controllers & capability',
          'screens': <dynamic>[
            _question(
              'turning_experience',
              'Turning ka kitna tajurba hai?',
              'single_select',
              options: const <List<String>>[
                <String>['below_1', '1 saal se kam'],
                <String>['one_to_three', '1 se 3 saal'],
              ],
            ),
            _question(
              'turning_machine',
              'Aap kaunsi turning machine chalate hain?',
              'multi_select',
              options: const <List<String>>[
                <String>['cnc_lathe', 'CNC lathe'],
              ],
            ),
            // ── f455bb36's universal append ──
            _question('primary_trade', 'Aap kaunsa kaam karte hain?', 'text'),
            _question('experience_years',
                'Is kaam mein aapko kitne saal ho gaye?', 'number'),
            _question('current_city', kUniversalCurrentCityPrompt, 'text'),
            _question('salary_expected',
                'Aap mahine ka kitna vetan chahte hain?', 'number'),
            _question('preferred_locations', kUniversalPreferredCityPrompt,
                'text'),
            _question(
              'availability',
              kUniversalAvailabilityPrompt,
              'single_select',
              options: const <List<String>>[
                <String>['immediate', 'Turant'],
                <String>['one_month', 'Ek mahine mein'],
              ],
            ),
            _question(
              'education',
              'Aapne kahaan tak padhai ki hai?',
              'single_select',
              options: const <List<String>>[
                <String>['tenth', '10vi'],
                <String>['iti_diploma', 'ITI ya Diploma'],
              ],
            ),
            _question(
              'shift_preference',
              'Aap din ki shift chahte hain ya raat ki?',
              'single_select',
              options: const <List<String>>[
                <String>['day', 'Din'],
                <String>['night', 'Raat'],
              ],
            ),
          ],
        },
        const <String, dynamic>{
          'id': 'terms',
          'title': 'Availability & terms',
          'screens': <dynamic>[
            <String, dynamic>{
              'type': 'preferences',
              'endpoint': 'PUT /workers/me/work-preferences',
            },
          ],
        },
        const <String, dynamic>{
          'id': 'work_history',
          'title': 'Work history',
          'screens': <dynamic>[
            <String, dynamic>{
              'type': 'employment',
              'endpoint': 'PUT /workers/me/employment',
            },
          ],
        },
        <String, dynamic>{
          'id': 'qualifications',
          'title': 'Qualification, documents & languages',
          'screens': <dynamic>[
            _question('iti_project_work', 'ITI me kya banaya tha?', 'text'),
            const <String, dynamic>{
              'type': 'qualifications',
              'endpoint': 'PUT /workers/me/qualifications',
              'suggested_certificates': <String>['NCVT Turner'],
            },
          ],
        },
      ],
    };
