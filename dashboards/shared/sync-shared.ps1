# Copy dashboards/shared/* into each dashboard (each Render service deploys only its own folder):
# shared.css + shared.js into public/, meta.js next to server.js.
# Edit files in dashboards/shared/, run this, then commit shared/ + the copies together.
#   .\shared\sync-shared.ps1          copy
#   .\shared\sync-shared.ps1 -Check   only diff; exit 1 if any copy is out of date
param([switch]$Check)
$root = Split-Path $PSScriptRoot -Parent
$files = [ordered]@{ 'shared.css' = 'public'; 'shared.js' = 'public'; 'meta.js' = '.' }
$targets = 'vid-thao', 'trang-mockup', 'van-featured-image'
$stale = 0
foreach ($t in $targets) {
  foreach ($f in $files.Keys) {
    $src = Join-Path $PSScriptRoot $f
    $dst = Join-Path (Join-Path (Join-Path $root $t) $files[$f]) $f
    $rel = if ($files[$f] -eq '.') { "$t/$f" } else { "$t/$($files[$f])/$f" }
    $same = (Test-Path $dst) -and ((Get-FileHash $src).Hash -eq (Get-FileHash $dst).Hash)
    if ($same) { continue }
    if ($Check) { Write-Output "STALE  $rel"; $stale++ }
    else { Copy-Item $src $dst -Force; Write-Output "copied $rel" }
  }
}
if ($Check) { if ($stale) { exit 1 } else { Write-Output 'all copies up to date' } }
