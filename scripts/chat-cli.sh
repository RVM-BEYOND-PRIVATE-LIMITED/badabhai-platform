#!/bin/sh
# ---------------------------------------------------------------------------
# Talk to the deterministic profiling interview from a terminal.
#
#   sh scripts/chat-cli.sh                 # new worker, new session
#   sh scripts/chat-cli.sh 54321           # pick the synthetic phone suffix
#
# Needs a running API (see the block at the bottom of this file) and a database
# that has been seeded AND normalized:
#
#   pnpm --filter @badabhai/db db:seed:domains     --apply
#   pnpm --filter @badabhai/db db:normalize:aliases --apply   # <-- without this
#   pnpm --filter @badabhai/db db:seed:packs       --apply    #     nothing matches
#
# NO jq DEPENDENCY — node does the JSON, because jq is not installed on every box.
# ---------------------------------------------------------------------------
set -u

API=${API_URL:-http://localhost:3001}
TL=${TEST_LOGIN_TOKEN:-local-test-login-token-not-a-secret-32ch}
# SYNTHETIC_TEST_PHONE_PATTERN = /^\+910{5}\d{5}$/ — +91, FIVE zeros, five digits.
PHONE="+9100000${1:-12345}"
CONSENT_VERSION=${CONSENT_VERSION:-2026-06-01}

# Read one field out of a JSON blob on stdin. `$1` is a JS expression over `j`.
jf() {
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=eval(process.argv[1]);console.log(v==null?'':v)}catch(e){console.log('')}})" "$1"
}

say() { printf '%s\n' "$*"; }

say "connecting to $API as $PHONE"

LOGIN=$(curl -s -X POST "$API/auth/test-login" \
  -H 'content-type: application/json' -H "x-test-login-token: $TL" \
  -d "{\"phone\":\"$PHONE\"}")
TOKEN=$(printf '%s' "$LOGIN" | jf 'j.access_token')
if [ -z "$TOKEN" ]; then
  say "login failed. The three things that cause this:"
  say "  404 -> TEST_LOGIN_ENABLED is not true, the token does not match, or the phone is"
  say "         outside the synthetic range (+91 then FIVE zeros then five digits)."
  say "  429 -> the per-IP OTP cap. Every local run shares one IP, so the production"
  say "         default of 5/hour trips fast. Start the API with OTP_MAX_SENDS_PER_HOUR=1000."
  printf '%s\n' "$LOGIN" | head -c 300; echo
  exit 1
fi
AUTH="authorization: Bearer $TOKEN"

# Idempotent: re-accepting is harmless, and without it /chat/session 403s.
curl -s -o /dev/null -X POST "$API/consent/accept" -H 'content-type: application/json' -H "$AUTH" \
  -d "{\"consent_version\":\"$CONSENT_VERSION\",\"purposes\":[\"profiling\",\"resume_generation\"]}"

S=$(curl -s -X POST "$API/chat/session" -H 'content-type: application/json' -H "$AUTH" -d '{}')
SID=$(printf '%s' "$S" | jf 'j.session_id')
if [ -z "$SID" ]; then
  say "could not start a session:"; printf '%s\n' "$S" | head -c 300; echo; exit 1
fi

say ""
say "session $SID"
say "type your answers as a worker would. Ctrl-C or an empty line to stop."
say "----------------------------------------------------------------------"

TURN=0
while :; do
  printf '\nyou> '
  if ! IFS= read -r MSG; then break; fi
  [ -z "$MSG" ] && break

  # JSON-escape the input rather than interpolating it: a quote or backslash in
  # a worker's answer would otherwise produce an invalid body.
  BODY=$(MSG="$MSG" SID="$SID" node -e 'console.log(JSON.stringify({session_id:process.env.SID,text:process.env.MSG}))')
  R=$(curl -s -X POST "$API/chat/message" -H 'content-type: application/json' -H "$AUTH" -d "$BODY")

  REPLY=$(printf '%s' "$R" | jf 'j.reply')
  if [ -z "$REPLY" ]; then
    say "no reply — raw response:"; printf '%s\n' "$R" | head -c 400; echo; continue
  fi

  TURN=$((TURN + 1))
  printf 'bot> %s\n' "$REPLY"

  CHIPS=$(printf '%s' "$R" | jf '(j.suggested_followups||[]).join("  |  ")')
  [ -n "$CHIPS" ] && printf '     [ %s ]\n' "$CHIPS"

  META=$(printf '%s' "$R" | jf '`q=${j.asked_question_id??"-"} kind=${j.question_kind??"-"} ${j.progress?`progress=${j.progress.answered}/${j.progress.total}`:""} ${j.occupation_label?`occupation=${j.occupation_label}`:""}`')
  printf '     %s\n' "$META"

  ENDED=$(printf '%s' "$R" | jf 'j.session_ended===true||j.extraction_ready===true?"1":""')
  if [ -n "$ENDED" ]; then
    say ""
    say "----------------------------------------------------------------------"
    say "interview complete after $TURN turns. session=$SID"
    say "inspect it:"
    say "  SELECT question_key,status,coalesce(answer_text,answer_number::text,answer_bool::text)"
    say "    FROM worker_pack_answer ORDER BY answered_at;"
    say "  SELECT jsonb_pretty(payload) FROM events"
    say "    WHERE event_name='profile.interview_completed' ORDER BY occurred_at DESC LIMIT 1;"
    break
  fi
done

# ---------------------------------------------------------------------------
# Starting the API this script talks to (one terminal), from the repo root:
#
#   NODE_ENV=development \
#   DATABASE_URL=postgres://badabhai:badabhai@localhost:5432/badabhai_oie \
#   REDIS_URL=redis://localhost:6379 API_PORT=3001 \
#   FAST2SMS_API_KEY=dev-dummy FAST2SMS_SENDER_ID=BADBHI \
#   FAST2SMS_DLT_TEMPLATE_ID=dev-dummy \
#   ZEPTOMAIL_API_TOKEN=dev-dummy ZEPTOMAIL_MAIL_AGENT=dev-dummy \
#   EMAIL_FROM_ADDRESS=dev@example.test \
#   TEST_LOGIN_ENABLED=true \
#   TEST_LOGIN_TOKEN=local-test-login-token-not-a-secret-32ch \
#   AI_ENABLE_REAL_CALLS=false \
#   node apps/api/dist/main.js
#
# The alias index is cached IN-PROCESS with a 900 s refresh, so after running
# db:normalize:aliases you must restart the API or wait for the refresh.
# ---------------------------------------------------------------------------
