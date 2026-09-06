# Push project env vars from local .env to Vercel (production + preview + development), then redeploy.
# Run from project root:  .\push-firebase-env.ps1
#
# WHY THE FILE REDIRECT: PowerShell 5.1 pipes to native commands as UTF-16LE with a BOM
# ("$val | vercel env add" is what BOM-poisoned every value on Vercel and produced
# "\uFEFFAIzaSy..." in the client bundle -> "Firebase is not configured" /
# "auth/network-request-failed"). Writing a UTF-8-no-BOM temp file and letting cmd
# redirect it via "<" keeps the value byte-exact.

$ErrorActionPreference = 'Continue'  # vercel writes its banner to stderr; do NOT Stop here

# name in .env  ->  name Vercel must have (code reads the right-hand side)
$keys = [ordered]@{
  'NEXT_PUBLIC_FIREBASE_API_KEY'         = 'NEXT_PUBLIC_FIREBASE_API_KEY'
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'     = 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID'      = 'NEXT_PUBLIC_FIREBASE_PROJECT_ID'
  'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET'  = 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET'
  'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID' = 'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID'
  'NEXT_PUBLIC_FIREBASE_APP_ID'          = 'NEXT_PUBLIC_FIREBASE_APP_ID'
  'NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID'  = 'NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID'
  'FIREBASE_ADMIN_PROJECT_ID'            = 'FIREBASE_ADMIN_PROJECT_ID'
  'FIREBASE_ADMIN_CLIENT_EMAIL'          = 'FIREBASE_ADMIN_CLIENT_EMAIL'
  'FIREBASE_ADMIN_PRIVATE_KEY'           = 'FIREBASE_ADMIN_PRIVATE_KEY'
  'APP_ENCRYPTION_KEY'                   = 'APP_ENCRYPTION_KEY'
  'ELEVENLABS_API_KEY'                   = 'ELEVENLABS_API_KEY'
  'AGENT_ID'                             = 'ELEVENLABS_AGENT_ID'   # .env legacy name
  'TWILIO_AUTH'                          = 'TWILIO_AUTH_TOKEN'     # .env legacy name
  'OPENAI_API_KEY'                       = 'OPENAI_API_KEY'
  'ANTHROPIC_API_KEY'                    = 'ANTHROPIC_API_KEY'
  'GOOGLE_GENERATIVE_AI_API_KEY'         = 'GOOGLE_GENERATIVE_AI_API_KEY'
  'AI_MODEL_PROVIDER'                    = 'AI_MODEL_PROVIDER'
  'LOCAL_MODEL_URL'                      = 'LOCAL_MODEL_URL'
}

# Parse .env (strip surrounding quotes and any stray BOM/ZWNBSP from values)
$envMap = @{}
Get-Content .env -Encoding UTF8 | ForEach-Object {
  if ($_ -match '^\s*([\w.]+)\s*=\s*(.*)\s*$') {
    $v = $Matches[2].Trim()
    if ($v.StartsWith('"') -and $v.EndsWith('"') -and $v.Length -ge 2) { $v = $v.Substring(1, $v.Length - 2) }
    if ($v.StartsWith("'") -and $v.EndsWith("'") -and $v.Length -ge 2) { $v = $v.Substring(1, $v.Length - 2) }
    $v = $v.TrimStart([char]0xFEFF).Replace([char]0xFEFF + '', '')
    $envMap[$Matches[1]] = $v
  }
}

$tmp = Join-Path $env:TEMP 'vercel-env-value.tmp'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$targets = @('production', 'preview', 'development')

foreach ($src in $keys.Keys) {
  $name = $keys[$src]
  $val = $envMap[$src]
  if ([string]::IsNullOrEmpty($val)) { Write-Host "SKIP $name (empty in .env)" -ForegroundColor Yellow; continue }
  [IO.File]::WriteAllText($tmp, $val, $utf8NoBom)
  foreach ($t in $targets) {
    vercel env rm $name $t --yes 2>$null | Out-Null   # ignore "not found"
    $extra = @()
    if ($t -eq 'preview') { $extra = @('--yes') }      # accept default "all branches"
    cmd /c "vercel env add `"$name`" $t --type config --yes < `"$tmp`"" | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "FAIL $name / $t" -ForegroundColor Red }
  }
  Write-Host "SET $name" -ForegroundColor Cyan
}
Remove-Item $tmp -ErrorAction SilentlyContinue

# Verify by pulling production back and checking for the BOM
vercel env pull .env.verify --environment=production --yes | Out-Null
$bad = Select-String -Path .env.verify -Pattern ([char]0xFEFF) -SimpleMatch
if ($bad) { Write-Host "WARNING: BOM detected in pushed values:" -ForegroundColor Red; $bad | ForEach-Object { $_.Line.Split('=')[0] } }
else { Write-Host "Verify OK: no BOM in production values" -ForegroundColor Green }
Remove-Item .env.verify -ErrorAction SilentlyContinue

Write-Host "`nRedeploying production (no build cache)..." -ForegroundColor Green
vercel --prod --force
