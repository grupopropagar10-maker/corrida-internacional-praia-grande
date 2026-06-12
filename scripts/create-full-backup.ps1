param(
  [string]$WorkspacePath = "C:\Users\julio\Documents\Projeto Corrida internacional Praia Grande",
  [string]$BackupParent = "D:\corrida-backups",
  [int]$KeepLatest = 2,
  [switch]$SkipPrune
)

$ErrorActionPreference = 'Stop'

$backupParent = $BackupParent
New-Item -ItemType Directory -Path $backupParent -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $backupParent $timestamp
$firebaseDir = Join-Path $backupRoot 'firebase'
$workspaceZip = Join-Path $backupRoot 'workspace-full-current.zip'
$firebaseBase = 'https://corrida-praia-grande-default-rtdb.firebaseio.com'
$keys = @(
  'postos',
  'congregacoes',
  'distribuicoes',
  'postos_init',
  'admin_creds',
  'sub_admins',
  'designacoes',
  'categorias',
  'cong_config',
  'evento_config',
  'pedidos_ajuda_escala'
)

New-Item -ItemType Directory -Path $firebaseDir -Force | Out-Null

$firebaseCounts = foreach ($key in $keys) {
  $response = Invoke-WebRequest -UseBasicParsing -Uri ($firebaseBase + '/' + $key + '.json') -Method Get
  $raw = if ([string]::IsNullOrWhiteSpace($response.Content)) { 'null' } else { $response.Content }
  $filePath = Join-Path $firebaseDir ($key + '.json')
  Set-Content -Path $filePath -Value $raw -Encoding UTF8

  $parsed = $null
  try {
    $parsed = $raw | ConvertFrom-Json
  } catch {
    $parsed = $null
  }

  $type = if ($null -eq $parsed) {
    'null'
  } elseif ($parsed -is [System.Array]) {
    'array'
  } elseif ($parsed -is [pscustomobject]) {
    'object'
  } elseif ($parsed -is [bool]) {
    'boolean'
  } else {
    $parsed.GetType().Name
  }

  $count = if ($null -eq $parsed) {
    0
  } elseif ($parsed -is [System.Array]) {
    @($parsed).Count
  } elseif ($parsed -is [pscustomobject]) {
    @($parsed.PSObject.Properties.Name).Count
  } else {
    1
  }

  [pscustomobject]@{
    key = $key
    type = $type
    count = $count
  }
}

# Exclui pastas pesadas/duplicadas para o zip nao inchar (eram ~14GB por backup).
# Os dados criticos do Firebase ja estao salvos em texto na pasta 'firebase/' acima;
# o codigo-fonte esta versionado no git. O zip serve so como conveniencia leve.
$tarArgs = @(
  '-a', '-cf', $workspaceZip,
  '--exclude=./pre-deploy-backups',
  '--exclude=./firebase-incident-backups',
  '--exclude=./pre-fix-security-backup',
  '--exclude=./.git',
  '--exclude=./node_modules',
  '-C', $WorkspacePath, '.'
)
tar.exe @tarArgs

$zipList = tar.exe -tf $workspaceZip | Select-Object -First 5
if (-not $zipList) {
  throw 'Falha ao validar o arquivo zip do backup.'
}

$zipInfo = Get-Item $workspaceZip
$meta = [pscustomobject]@{
  timestamp = $timestamp
  createdAt = (Get-Date).ToString('o')
  workspaceArchive = $zipInfo.Name
  workspaceArchiveSizeMB = [math]::Round($zipInfo.Length / 1MB, 2)
  firebaseKeys = $keys
  firebaseCounts = $firebaseCounts
  includesExistingBackups = $true
  notes = 'Backup completo criado antes de alterações, com retenção curta automática.'
}
$meta | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $backupRoot 'backup-meta.json') -Encoding UTF8

$deletedBackups = @()
if (-not $SkipPrune -and $KeepLatest -ge 1) {
  $allBackupDirs = Get-ChildItem -Path $backupParent -Directory | Sort-Object LastWriteTime -Descending
  $toRemove = @($allBackupDirs | Select-Object -Skip $KeepLatest)
  foreach ($dir in $toRemove) {
    if ($dir.FullName -ne $backupRoot) {
      Remove-Item -Path $dir.FullName -Recurse -Force
      $deletedBackups += $dir.Name
    }
  }
}

[pscustomobject]@{
  backupRoot = $backupRoot
  workspaceZipMB = [math]::Round($zipInfo.Length / 1MB, 2)
  keptLatest = $KeepLatest
  deletedBackups = $deletedBackups
} | Format-List