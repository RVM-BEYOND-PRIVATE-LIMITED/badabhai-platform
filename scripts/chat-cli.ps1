<#
.SYNOPSIS
  Talk to the deterministic profiling interview from a PowerShell terminal, then print
  the resume JSON, the AI cost summary, and the turn-latency profile for the session.

.EXAMPLE
  .\scripts\chat-cli.ps1
  .\scripts\chat-cli.ps1 -PhoneSuffix 54321      # a different synthetic worker
  .\scripts\chat-cli.ps1 -ApiUrl http://localhost:3001

.NOTES
  Needs a running API and a database that has been seeded AND normalized:

    pnpm --filter @badabhai/db db:seed:domains      --apply
    pnpm --filter @badabhai/db db:normalize:aliases --apply   # <-- without this,
    pnpm --filter @badabhai/db db:seed:packs        --apply   #     nothing matches

  The alias index is cached IN-PROCESS with a 900 s refresh, so after running
  db:normalize:aliases you must restart the API or wait for the refresh.

  The three post-interview reports need INTERNAL_SERVICE_TOKEN to match the value the
  API booted with -- they read the OPS routes (`/ai-jobs`, `/workers/:id/profile`),
  never the worker-facing ones. That is deliberate: `/workers/me/profile` returns only
  `{id, profile_status}` and `/workers/me/ai-jobs/:id` withholds cost ON PURPOSE, and a
  dev CLI is not a reason to widen either. Without the token the interview still runs
  and latency still prints; only the cost and resume sections are skipped.

  See the env block at the bottom of this file for how to boot the API.
#>
[CmdletBinding()]
param(
  [string]$ApiUrl          = $(if ($env:API_URL) { $env:API_URL } else { 'http://localhost:3001' }),
  # SYNTHETIC_TEST_PHONE_PATTERN = /^\+910{5}\d{5}$/ -- +91, FIVE zeros, five digits.
  [ValidatePattern('^\d{5}$')]
  [string]$PhoneSuffix     = '12345',
  # A worker who already has an extracted profile is SKIPPED by auto-extract, so a second
  # interview on the same suffix yields no draft and no cost line. This picks an unused suffix.
  [switch]$NewWorker,
  [string]$TestLoginToken  = $(if ($env:TEST_LOGIN_TOKEN) { $env:TEST_LOGIN_TOKEN } else { 'local-test-login-token-not-a-secret-32ch' }),
  [string]$InternalToken   = $(if ($env:INTERNAL_SERVICE_TOKEN) { $env:INTERNAL_SERVICE_TOKEN } else { 'local-internal-service-token' }),
  [string]$ConsentVersion  = '2026-06-01',
  # Extraction is queued on BullMQ, so the profile lands AFTER the interview closes -- and it
  # RETRIES on the queue's backoff, so a job whose first attempt fails lands minutes later, not
  # seconds. Measured on this box: 5m04s from enqueue to completion, with the provider calls
  # five minutes in. The old 20 s was a wall clock tuned for the happy path, so every retried
  # job reported "no profile extracted" on a run that was working perfectly.
  #
  # 0 = NO CEILING: poll until the job reaches a terminal state, Ctrl-C to give up. The wait is
  # bounded by the JOB's own state either way -- `failed` breaks out immediately rather than
  # burning the rest of the clock on a job that will never produce a draft.
  [int]$WaitSeconds        = 300
)

$ErrorActionPreference = 'Stop'
if ($NewWorker) {
  # Time-derived, not Get-Random: two runs a second apart must not collide, and a seeded RNG in a
  # fresh PowerShell process is exactly the thing that would. Five digits is the whole width
  # SYNTHETIC_TEST_PHONE_PATTERN allows, so this wraps every ~27 hours -- fine for a dev box.
  $PhoneSuffix = ([int](([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) % 100000)).ToString('00000')
}
$phone = "+9100000$PhoneSuffix"

function Show-Failure($Message, $ErrorRecord) {
  Write-Host $Message -ForegroundColor Red
  $body = $null
  try { $body = $ErrorRecord.ErrorDetails.Message } catch {}
  if ($body) { Write-Host $body -ForegroundColor DarkGray }
}

function Write-Rule { Write-Host ("-" * 70) -ForegroundColor DarkGray }

function Write-Section($Title) {
  Write-Host ""
  Write-Host $Title -ForegroundColor Cyan
  Write-Rule
}

# Nearest-rank percentile. Deliberately NOT interpolated: with 13 samples an
# interpolated p95 invents a number no turn actually took, and the whole point of
# printing this next to the 400 ms gate is that every figure is a real turn.
function Get-Percentile([int[]]$Sorted, [double]$P) {
  if ($Sorted.Count -eq 0) { return 0 }
  $i = [math]::Ceiling($P * $Sorted.Count) - 1
  if ($i -lt 0) { $i = 0 }
  if ($i -ge $Sorted.Count) { $i = $Sorted.Count - 1 }
  return $Sorted[$i]
}

Write-Host "connecting to $ApiUrl as $phone" -ForegroundColor DarkGray

# ---- 1. test-login. OTP is real-only; this seam is the only way in. --------
try {
  $login = Invoke-RestMethod -Method Post -Uri "$ApiUrl/auth/test-login" `
    -Headers @{ 'x-test-login-token' = $TestLoginToken } `
    -ContentType 'application/json' `
    -Body (@{ phone = $phone } | ConvertTo-Json -Compress)
} catch {
  Show-Failure "login failed. The three things that cause this:" $_
  Write-Host "  404 -> TEST_LOGIN_ENABLED is not true, the token does not match, or the phone" -ForegroundColor DarkGray
  Write-Host "         is outside the synthetic range (+91 then FIVE zeros then five digits)." -ForegroundColor DarkGray
  Write-Host "  429 -> the per-IP OTP cap. Every local run shares one IP, so the production" -ForegroundColor DarkGray
  Write-Host "         default of 10/hour trips fast. Start the API with" -ForegroundColor DarkGray
  Write-Host "         WORKER_OTP_MAX_SENDS_PER_HOUR=1000 (the worker knob, #1421)." -ForegroundColor DarkGray
  exit 1
}
$auth     = @{ authorization = "Bearer $($login.access_token)" }
$internal = @{ 'x-internal-service-token' = $InternalToken }
$workerId = $login.worker_id

# ---- 2. DPDP consent. /chat/session 403s without it. Re-accepting is safe. --
try {
  Invoke-RestMethod -Method Post -Uri "$ApiUrl/consent/accept" -Headers $auth `
    -ContentType 'application/json' `
    -Body (@{ consent_version = $ConsentVersion; purposes = @('profiling','resume_generation') } | ConvertTo-Json -Compress) | Out-Null
} catch {
  Show-Failure "consent failed (is CONSENT_VERSION right?)" $_
  exit 1
}

# ---- 3. Baseline the AI jobs BEFORE the interview starts. -------------------
#
# An ID SET, not a timestamp cutoff. The cost report has to attribute jobs to THIS
# session, and this worker may already have profiles from earlier runs under the same
# synthetic phone. Diffing ids is exact; a `created_at >=` filter would depend on the
# PowerShell and Postgres clocks agreeing.
$opsReady = $true
$jobsBefore = @{}
try {
  foreach ($j in (Invoke-RestMethod -Uri "$ApiUrl/ai-jobs?limit=100" -Headers $internal).ai_jobs) {
    $jobsBefore[$j.id] = $true
  }
} catch {
  $opsReady = $false
  Write-Host "note: ops routes unreachable -- cost and resume JSON will be skipped." -ForegroundColor DarkYellow
  Write-Host "      start the API with INTERNAL_SERVICE_TOKEN=$InternalToken to enable them." -ForegroundColor DarkGray
}

# ---- 4. session ------------------------------------------------------------
try {
  $session = Invoke-RestMethod -Method Post -Uri "$ApiUrl/chat/session" -Headers $auth `
    -ContentType 'application/json' -Body '{}'
} catch {
  Show-Failure "could not start a session" $_
  exit 1
}
$sid = $session.session_id

Write-Host ""
Write-Host "session $sid"
Write-Host "type your answers as a worker would. Empty line or Ctrl-C to stop."
Write-Rule

# ---- 5. the interview ------------------------------------------------------
$turn        = 0
$turnMs      = New-Object System.Collections.Generic.List[int]
$completed   = $false
# When the turn currently being sent began. `finalizeInterview` enqueues extraction from
# INSIDE the closing turn's request, so this -- not the moment that response came back -- is
# the only cutoff that puts the extraction job on the completion side of the ledger.
$lastTurnAt  = [DateTime]::UtcNow

while ($true) {
  Write-Host ""
  Write-Host "you> " -NoNewline -ForegroundColor Cyan
  $msg = Read-Host
  if ([string]::IsNullOrWhiteSpace($msg)) { break }

  # WALL CLOCK, not a server-reported number: it includes HTTP, JSON and PowerShell, so it
  # can only ever OVERSTATE the turn. That is what makes it a sound stand-in for the gate
  # without reading the DB -- if the client p95 clears 400 ms, the server's own
  # `turn_latency_ms` histogram on `profile.interview_completed` cleared it by more.
  $lastTurnAt = [DateTime]::UtcNow
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$ApiUrl/chat/message" -Headers $auth `
      -ContentType 'application/json' `
      -Body (@{ session_id = $sid; text = $msg } | ConvertTo-Json -Compress)
  } catch {
    $sw.Stop()
    Show-Failure "turn failed" $_
    continue
  }
  $sw.Stop()
  $ms = [int]$sw.ElapsedMilliseconds
  $turnMs.Add($ms)

  $turn++
  Write-Host "bot> " -NoNewline -ForegroundColor Green
  Write-Host $r.reply

  if ($r.suggested_followups -and $r.suggested_followups.Count -gt 0) {
    Write-Host ("     [ " + ($r.suggested_followups -join '  |  ') + " ]") -ForegroundColor Yellow
  }

  $meta = "     q=$($r.asked_question_id) kind=$($r.question_kind)"
  if ($r.progress)         { $meta += " progress=$($r.progress.answered)/$($r.progress.total)" }
  if ($r.occupation_label) { $meta += " occupation=$($r.occupation_label)" }
  $meta += " t=${ms}ms"
  Write-Host $meta -ForegroundColor DarkGray

  if ($r.extraction_ready -or $r.session_ended) { $completed = $true; break }
}

Write-Host ""
Write-Rule
if ($completed) {
  Write-Host "interview complete after $turn turns. session=$sid" -ForegroundColor Green
} else {
  Write-Host "stopped after $turn turns (interview not finished). session=$sid" -ForegroundColor DarkYellow
}
# The cutoff that splits "spent deciding what to ask" from "spent turning the finished
# interview into a profile" -- the distinction the whole deterministic engine exists to
# make, and therefore the one number in this report worth getting exactly right.
$closedAt = $lastTurnAt

# ---- 6. LATENCY ------------------------------------------------------------
Write-Section "TURN LATENCY (client wall clock, includes HTTP)"
if ($turnMs.Count -eq 0) {
  Write-Host "  no turns recorded." -ForegroundColor DarkGray
} else {
  $sorted = [int[]]($turnMs | Sort-Object)
  $p95    = Get-Percentile $sorted 0.95
  $sum    = 0; foreach ($v in $sorted) { $sum += $v }
  Write-Host ("  turns {0}   min {1} ms   p50 {2} ms   p95 {3} ms   max {4} ms   total {5} ms" -f `
    $sorted.Count, $sorted[0], (Get-Percentile $sorted 0.50), $p95, $sorted[-1], $sum)
  $verdict = if ($p95 -le 400) { "PASS" } else { "OVER" }
  $colour  = if ($p95 -le 400) { "Green" } else { "Red" }
  Write-Host ("  p95 vs the <=400 ms deterministic-turn gate: {0}" -f $verdict) -ForegroundColor $colour
  Write-Host ("  per turn: " + (($turnMs | ForEach-Object { "${_}ms" }) -join '  ')) -ForegroundColor DarkGray
}

if (-not $opsReady) {
  Write-Host ""
  Write-Host "cost and resume JSON skipped (no ops access)." -ForegroundColor DarkYellow
  exit 0
}

# ---- 7. wait for the queue, then diff the AI jobs ---------------------------
# Extraction is enqueued on BullMQ at completion, so polling is not optional here.
#
# WAITING ON STATE, NOT ON A CLOCK. The exit condition is "every new job has left queued/running",
# which is true the moment the work is actually done -- so the common case still returns in
# seconds and only a retrying job costs the extra minutes. A silent multi-minute pause reads as a
# hang, so the heartbeat says what is being waited on and for how long.
$unlimited = ($WaitSeconds -le 0)
$startedAt = Get-Date
$deadline  = $startedAt.AddSeconds([Math]::Max($WaitSeconds, 0))
$newJobs   = @()
$beat      = 0
while ($unlimited -or (Get-Date) -lt $deadline) {
  try {
    $all = (Invoke-RestMethod -Uri "$ApiUrl/ai-jobs?limit=100" -Headers $internal).ai_jobs
  } catch { break }
  $newJobs = @($all | Where-Object { -not $jobsBefore.ContainsKey($_.id) })
  $pending = @($newJobs | Where-Object { $_.status -eq 'queued' -or $_.status -eq 'running' })
  if ($newJobs.Count -gt 0 -and $pending.Count -eq 0) { break }
  # Every 10 s, and only once there is something to report -- before the job row exists there is
  # nothing to say beyond "still nothing", which is what the interview's own output already said.
  $beat++
  if ($beat % 20 -eq 0 -and $pending.Count -gt 0) {
    $elapsed = [int]((Get-Date) - $startedAt).TotalSeconds
    $ceiling = if ($unlimited) { 'no ceiling' } else { "${WaitSeconds}s ceiling" }
    Write-Host ("  waiting on {0} job(s) [{1}] -- {2}s elapsed, {3}" -f `
      $pending.Count, (($pending | ForEach-Object { $_.status }) -join ','), $elapsed, $ceiling) `
      -ForegroundColor DarkGray
  }
  Start-Sleep -Milliseconds 500
}

Write-Section "AI COST FOR THIS SESSION"
$during = @($newJobs | Where-Object { ([DateTime]$_.created_at).ToUniversalTime() -lt $closedAt })
$after  = @($newJobs | Where-Object { ([DateTime]$_.created_at).ToUniversalTime() -ge $closedAt })

# THE HEADLINE NUMBER. The engine's entire economic claim is that turn-taking costs
# nothing, so it is asserted here rather than described.
$duringColour = if ($during.Count -eq 0) { "Green" } else { "Red" }
Write-Host ("  {0,-44}: {1}" -f "AI jobs while deciding questions ($turn turns)", $during.Count) -ForegroundColor $duringColour
Write-Host ("  {0,-44}: {1}" -f "AI jobs at completion (extraction/parse)", $after.Count)

$totalInr = 0.0; $totalTok = 0; $realCalls = 0
if ($newJobs.Count -gt 0) {
  Write-Host ""
  Write-Host ("  {0,-20} {1,-10} {2,-22} {3,-6} {4,7} {5,8} {6,10}" -f `
    'job_type','status','model','real','in','out','INR')
  foreach ($j in $newJobs) {
    # The list route carries cost but not the token split; :id carries both.
    $u = $null
    try { $u = Invoke-RestMethod -Uri "$ApiUrl/ai-jobs/$($j.id)" -Headers $internal } catch {}
    $usage = if ($u) { $u.ai_usage } else { $null }
    $inr   = if ($usage -and $null -ne $usage.cost_inr) { [double]$usage.cost_inr } else { 0.0 }
    $tin   = if ($usage -and $null -ne $usage.input_tokens)  { [int]$usage.input_tokens }  else { 0 }
    $tout  = if ($usage -and $null -ne $usage.output_tokens) { [int]$usage.output_tokens } else { 0 }
    $real  = if ($usage) { $usage.real_call } else { $null }
    if ($real -eq $true) { $realCalls++ }
    $totalInr += $inr
    $totalTok += ($tin + $tout)
    Write-Host ("  {0,-20} {1,-10} {2,-22} {3,-6} {4,7} {5,8} {6,10}" -f `
      $j.job_type, $j.status,
      $(if ($usage -and $usage.model_name) { $usage.model_name } else { '-' }),
      $(if ($null -eq $real) { '-' } elseif ($real) { 'yes' } else { 'no' }),
      $tin, $tout, $inr.ToString('0.0000'))
  }
  Write-Host ""
  Write-Host ("  TOTAL  {0} tokens   Rs {1}" -f $totalTok, $totalInr.ToString('0.0000')) -ForegroundColor Green
  $budget = if ($totalInr -le 15) { "PASS" } else { "OVER" }
  Write-Host ("  vs the <=Rs 15 per-profile budget: {0}" -f $budget) -ForegroundColor $(if ($totalInr -le 15) { "Green" } else { "Red" })
  if ($realCalls -eq 0) {
    # WHY, not just THAT. "Rs 0.00" has two completely different causes and the fix differs:
    # a service that is down is a process problem, a service that is up and still mock is a
    # gate problem. Asking the API's own /health rather than guessing means this line cannot
    # go stale the moment someone starts the ai-service.
    $posture = $null
    try { $posture = Invoke-RestMethod -Uri "$ApiUrl/health" -TimeoutSec 5 } catch {}
    $svc = if ($posture) { $posture.checks.ai_service } else { $null }
    Write-Host "  NOTE: Rs 0.00 is the TRUE cost here, not a missing figure -- no provider call" -ForegroundColor DarkYellow
    if ($svc -ne 'up') {
      Write-Host "        was made because the ai-service is not running (health: ai_service=$svc)." -ForegroundColor DarkGray
      Write-Host "        Start it, then re-run." -ForegroundColor DarkGray
    } else {
      Write-Host "        was made because the ai-service is up but still gated (posture=$($posture.checks.ai_posture))." -ForegroundColor DarkGray
      Write-Host "        All four gates must hold; check which one is closed:" -ForegroundColor DarkGray
      Write-Host "          curl -s http://127.0.0.1:8000/health   -> real_calls_enabled" -ForegroundColor DarkGray
      Write-Host "        Usually GEMINI_FLASH_API_KEY. Set it on the ai-service and restart it." -ForegroundColor DarkGray
    }
  }
} elseif ($completed) {
  # NOT a failure, and the reason is worth naming because the fix is a flag, not a debug session.
  # `autoTriggerExtraction` skips a worker who already has a profile with extracted content
  # (chat.service.ts, "auto-extract skipped ... worker already has profile"). Re-running under a
  # phone suffix that has already completed an interview therefore produces no job and no new
  # profile -- and this script used to respond by printing the OLD one as if it were this one.
  Write-Host "  none -- this worker already has an extracted profile, so auto-extract skipped." -ForegroundColor DarkYellow
  Write-Host "  that dedupe is deliberate. Run with a fresh worker to get a new extraction:" -ForegroundColor DarkGray
  Write-Host "      .\scripts\chat-cli.ps1 -NewWorker" -ForegroundColor DarkGray
} else {
  Write-Host "  none -- the interview did not reach completion, so nothing was queued." -ForegroundColor DarkGray
}

# ---- 8. the resume JSON ----------------------------------------------------
Write-Section "RESUME JSON (the draft handed to resume generation)"
$newJobIds = @{}; foreach ($j in $newJobs) { $newJobIds[$j.id] = $true }

$profile = $null
if ($newJobIds.Count -eq 0) {
  # NO ESCAPE HATCH. This branch used to fall back to "whatever `latestProfile` returns", which is
  # how a nine-turn interview about a Delhi developer printed a CNC operator from Pune extracted an
  # hour earlier: same synthetic phone, same worker row, no new job, stale profile rendered as if
  # it were this conversation. A report that cannot prove which session it belongs to is worse
  # than no report, because it reads exactly like a working one.
  Write-Host "  skipped: no extraction ran for this session, so there is no draft to show." -ForegroundColor DarkYellow
  Write-Host "  printing this worker's previous profile here would misattribute it." -ForegroundColor DarkGray
} else {
  # THE SECOND WAIT IS NOT REDUNDANT. Loop 7 waits for the JOB to leave running; the profile row
  # is written by that job and can lag it by a beat. It gets its own clock rather than the
  # remainder of the first one, because a job that took four minutes to succeed has not earned a
  # zero-second budget to land its row.
  $startedAt = Get-Date
  $deadline  = $startedAt.AddSeconds([Math]::Max($WaitSeconds, 0))
  $beat      = 0
  while ($unlimited -or (Get-Date) -lt $deadline) {
    try {
      $bundle = Invoke-RestMethod -Uri "$ApiUrl/workers/$workerId/profile" -Headers $internal
    } catch { break }
    $p = $bundle.profile
    # Match on aiJobId: `latestProfile` is ordered by recency and knows nothing about which
    # session asked for it, so identity has to come from the job THIS run watched get created.
    if ($p -and $p.richProfileDraft -and $newJobIds.ContainsKey($p.aiJobId)) { $profile = $p; break }
    # A job that has already FAILED will never write the row -- waiting out the ceiling on it
    # teaches nothing and hides the reason. Re-read status rather than trusting the snapshot
    # loop 7 took, since a retry can fail after that loop returned.
    try {
      $still = (Invoke-RestMethod -Uri "$ApiUrl/ai-jobs?limit=100" -Headers $internal).ai_jobs |
               Where-Object { $newJobIds.ContainsKey($_.id) }
      if (@($still | Where-Object { $_.status -eq 'queued' -or $_.status -eq 'running' }).Count -eq 0 -and
          @($still | Where-Object { $_.status -eq 'completed' }).Count -eq 0) {
        Write-Host ("  extraction ended without a draft: {0}" -f (($still | ForEach-Object { $_.status }) -join ',')) -ForegroundColor DarkYellow
        break
      }
    } catch {}
    $beat++
    if ($beat % 20 -eq 0) {
      $elapsed = [int]((Get-Date) - $startedAt).TotalSeconds
      Write-Host ("  waiting for the profile row -- {0}s elapsed" -f $elapsed) -ForegroundColor DarkGray
    }
    Start-Sleep -Milliseconds 500
  }
}

if ($newJobIds.Count -gt 0 -and -not $profile) {
  # NAME THE JOB'S ACTUAL STATE. "no profile within Ns" describes the clock, not the system, and
  # sent the last reader looking for a config problem when the job was simply on its second
  # attempt. The status is the one fact that separates "still working" from "gave up".
  $last = $null
  try {
    $last = (Invoke-RestMethod -Uri "$ApiUrl/ai-jobs?limit=100" -Headers $internal).ai_jobs |
            Where-Object { $newJobIds.ContainsKey($_.id) }
  } catch {}
  $states = if ($last) { (($last | ForEach-Object { "$($_.job_type)=$($_.status)" }) -join ', ') } else { 'unknown (ops route unreachable)' }
  Write-Host ("  no draft yet. job state: {0}" -f $states) -ForegroundColor DarkYellow
  Write-Host "  extraction retries on the queue's backoff, so a job whose first attempt fails" -ForegroundColor DarkGray
  Write-Host "  lands minutes later. Wait indefinitely with -WaitSeconds 0, or read it after:" -ForegroundColor DarkGray
  Write-Host ("      curl -s -H 'x-internal-token: <token>' {0}/workers/{1}/profile" -f $ApiUrl, $workerId) -ForegroundColor DarkGray
} elseif ($profile) {
  Write-Host ("  profile_id  {0}" -f $profile.id) -ForegroundColor DarkGray
  Write-Host ("  status      {0}" -f $profile.profileStatus) -ForegroundColor DarkGray
  Write-Host ("  occupation  {0}  match={1} layer={2}" -f `
    $(if ($profile.jobDomainId) { $profile.jobDomainId } else { '-' }),
    $(if ($profile.jobDomainMatchStatus) { $profile.jobDomainMatchStatus } else { '-' }),
    $(if ($profile.jobDomainMatchLayer) { $profile.jobDomainMatchLayer } else { '-' })) -ForegroundColor DarkGray
  Write-Host ""
  Write-Host ($profile.richProfileDraft | ConvertTo-Json -Depth 12)
}

Write-Host ""
Write-Rule
Write-Host "raw SQL for the same session:" -ForegroundColor DarkGray
Write-Host "  docker exec -it badabhai-postgres psql -U badabhai -d badabhai_oie" -ForegroundColor DarkGray
Write-Host "  SELECT question_key,status,coalesce(answer_text,answer_number::text,answer_bool::text)" -ForegroundColor DarkGray
Write-Host "    FROM worker_pack_answer ORDER BY answered_at;" -ForegroundColor DarkGray
Write-Host "  SELECT jsonb_pretty(payload) FROM events" -ForegroundColor DarkGray
Write-Host "    WHERE event_name='profile.interview_completed' ORDER BY occurred_at DESC LIMIT 1;" -ForegroundColor DarkGray

<#
  Starting the API this script talks to, in another PowerShell window, from the repo root:

    $env:NODE_ENV="development"
    $env:DATABASE_URL="postgres://badabhai:badabhai@localhost:5432/badabhai_oie"
    $env:REDIS_URL="redis://localhost:6379"
    $env:API_PORT="3001"
    $env:FAST2SMS_API_KEY="dev-dummy"; $env:FAST2SMS_SENDER_ID="BADBHI"
    $env:FAST2SMS_DLT_TEMPLATE_ID="dev-dummy"
    $env:ZEPTOMAIL_API_TOKEN="dev-dummy"; $env:ZEPTOMAIL_MAIL_AGENT="dev-dummy"
    $env:EMAIL_FROM_ADDRESS="dev@example.test"
    $env:TEST_LOGIN_ENABLED="true"
    $env:TEST_LOGIN_TOKEN="local-test-login-token-not-a-secret-32ch"
    $env:INTERNAL_SERVICE_TOKEN="local-internal-service-token"
    $env:OTP_MAX_SENDS_PER_HOUR="1000"; $env:WORKER_OTP_MAX_SENDS_PER_HOUR="1000"
    $env:OTP_MAX_SENDS_PER_DAY="1000"
    $env:AI_ENABLE_REAL_CALLS="false"
    node apps/api/dist/main.js
#>
