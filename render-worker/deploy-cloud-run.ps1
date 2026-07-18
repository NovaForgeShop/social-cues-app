param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectId,
  [string]$Region = "us-east4",
  [string]$Repository = "social-cues",
  [string]$JobName = "social-cues-render-worker",
  [string]$SchedulerName = "social-cues-render-every-minute",
  [string]$ServiceAccountName = "social-cues-render"
)

$ErrorActionPreference = "Stop"

function Invoke-Gcloud {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & gcloud @Arguments
  if ($LASTEXITCODE -ne 0) { throw "gcloud failed: $($Arguments -join ' ')" }
}

function Test-GcloudResource {
  param([string[]]$Arguments)
  & gcloud @Arguments *> $null
  return $LASTEXITCODE -eq 0
}

function Read-SecretValue {
  param([string]$Name, [string]$EnvironmentName)
  $existing = [Environment]::GetEnvironmentVariable($EnvironmentName)
  if ($existing) { return $existing }
  $secure = Read-Host "Enter $Name" -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Add-SecretVersion {
  param([string]$Name, [string]$Value)
  $secretFile = Join-Path ([IO.Path]::GetTempPath()) ("social-cues-secret-" + [Guid]::NewGuid().ToString("N"))
  try {
    [IO.File]::WriteAllText($secretFile, $Value, [Text.UTF8Encoding]::new($false))
    Invoke-Gcloud secrets versions add $Name --data-file=$secretFile --project=$ProjectId
  } finally {
    if (Test-Path -LiteralPath $secretFile) {
      [IO.File]::WriteAllBytes($secretFile, [byte[]]::new([Text.Encoding]::UTF8.GetByteCount($Value)))
      Remove-Item -LiteralPath $secretFile -Force
    }
  }
}

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw "Google Cloud CLI is not installed. Install it, run gcloud auth login, then rerun this script."
}

$activeAccount = (& gcloud auth list --filter=status:ACTIVE --format="value(account)").Trim()
if (-not $activeAccount) { throw "Google Cloud CLI has no active login. Run gcloud auth login first." }

Invoke-Gcloud config set project $ProjectId
Invoke-Gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com --project=$ProjectId

$serviceAccountEmail = "$ServiceAccountName@$ProjectId.iam.gserviceaccount.com"
if (-not (Test-GcloudResource @("iam", "service-accounts", "describe", $serviceAccountEmail, "--project=$ProjectId"))) {
  Invoke-Gcloud iam service-accounts create $ServiceAccountName --display-name="Social Cues isolated render worker" --project=$ProjectId
}

if (-not (Test-GcloudResource @("artifacts", "repositories", "describe", $Repository, "--location=$Region", "--project=$ProjectId"))) {
  Invoke-Gcloud artifacts repositories create $Repository --repository-format=docker --location=$Region --description="Social Cues private render images" --project=$ProjectId
}

$secretValues = @{
  "social-cues-supabase-url" = Read-SecretValue "Supabase project URL" "SUPABASE_URL"
  "social-cues-supabase-service-key" = Read-SecretValue "Supabase service role or secret key" "SUPABASE_SERVICE_ROLE_KEY"
}
foreach ($secretName in $secretValues.Keys) {
  if (-not (Test-GcloudResource @("secrets", "describe", $secretName, "--project=$ProjectId"))) {
    Invoke-Gcloud secrets create $secretName --replication-policy=automatic --project=$ProjectId
  }
  Add-SecretVersion $secretName $secretValues[$secretName]
  Invoke-Gcloud secrets add-iam-policy-binding $secretName --member="serviceAccount:$serviceAccountEmail" --role="roles/secretmanager.secretAccessor" --project=$ProjectId
}

$image = "$Region-docker.pkg.dev/$ProjectId/$Repository/render-worker:latest"
Invoke-Gcloud builds submit $PSScriptRoot --tag=$image --project=$ProjectId
Invoke-Gcloud run jobs deploy $JobName --image=$image --region=$Region --service-account=$serviceAccountEmail --cpu=2 --memory=4Gi --task-timeout=30m --max-retries=0 --tasks=1 --set-env-vars="MEDIA_STORAGE_BUCKET=social-cues-media,RENDER_WORKER_BATCH_SIZE=2,RENDER_WORKER_LEASE_SECONDS=1800" --set-secrets="SUPABASE_URL=social-cues-supabase-url:latest,SUPABASE_SERVICE_ROLE_KEY=social-cues-supabase-service-key:latest" --project=$ProjectId
Invoke-Gcloud run jobs add-iam-policy-binding $JobName --region=$Region --member="serviceAccount:$serviceAccountEmail" --role="roles/run.invoker" --project=$ProjectId

$runUri = "https://run.googleapis.com/v2/projects/$ProjectId/locations/$Region/jobs/$JobName`:run"
if (Test-GcloudResource @("scheduler", "jobs", "describe", $SchedulerName, "--location=$Region", "--project=$ProjectId")) {
  Invoke-Gcloud scheduler jobs update http $SchedulerName --location=$Region --schedule="* * * * *" --uri=$runUri --http-method=POST --oauth-service-account-email=$serviceAccountEmail --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" --project=$ProjectId
} else {
  Invoke-Gcloud scheduler jobs create http $SchedulerName --location=$Region --schedule="* * * * *" --uri=$runUri --http-method=POST --oauth-service-account-email=$serviceAccountEmail --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" --project=$ProjectId
}

Invoke-Gcloud run jobs execute $JobName --region=$Region --wait --project=$ProjectId
Write-Host "Cloud Run render worker deployed and its empty-run heartbeat completed."
Write-Host "Keep MEDIA_RENDER_WORKER_CONFIGURED=false until one uploaded source produces private completed outputs."
