# Copy dashboards/shared/* into each dashboard's public/ (each Render service deploys only its own folder).
# Edit files in dashboards/shared/, run this, then commit shared/ + the 3 copies together.
#   .\shared\sync-shared.ps1          copy
#   .\shared\sync-shared.ps1 -Check   only diff; exit 1 if any copy is out of date
param([switch]$Check)
$root = Split-Path $PSScriptRoot -Parent
$files = 'shared.css', 'shared.js'
$targets = 'vid-thao', 'trang-mockup', 'van-featured-image'
$stale = 0
foreach ($t in $targets) {
  foreach ($f in $files) {
    $src = Join-Path $PSScriptRoot $f
    $dst = Join-Path $root "$t\public\$f"
    $same = (Test-Path $dst) -and ((Get-FileHash $src).Hash -eq (Get-FileHash $dst).Hash)
    if ($same) { continue }
    if ($Check) { Write-Output "STALE  $t/public/$f"; $stale++ }
    else { Copy-Item $src $dst -Force; Write-Output "copied $t/public/$f" }
  }
}
if ($Check) { if ($stale) { exit 1 } else { Write-Output 'all copies up to date' } }
