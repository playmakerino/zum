# sync-shared.ps1 - the compositor engine lives byte-identical in pattern-mockup.html (dev tool) and
# zum_prd_form.html (production form), between the "// ===== SHARED BLOCK" and "// ===== END SHARED BLOCK"
# marker lines. Both pages stay single-file, so the block is duplicated, and this script keeps the two
# copies equal.
#   .\sync-shared.ps1          diff the two copies (exit 1 when they differ)
#   .\sync-shared.ps1 -Push    copy the block from pattern-mockup.html into zum_prd_form.html
param([switch]$Push)
$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $dir 'pattern-mockup.html'
$dst = Join-Path $dir 'zum_prd_form.html'
$START = '// ===== SHARED BLOCK'
$END   = '// ===== END SHARED BLOCK ====='
$enc = New-Object System.Text.UTF8Encoding($false)   # no BOM: the pages declare their charset

function Get-Block([string]$path) {
    $t = [IO.File]::ReadAllText($path, $enc)
    $a = $t.IndexOf($START); $b = $t.IndexOf($END)
    if ($a -lt 0 -or $b -lt $a) { throw "shared-block markers missing in $path" }
    if ($t.IndexOf($START, $a + 1) -ge 0) { throw "more than one shared block in $path" }
    $b += $END.Length
    @{ text = $t; start = $a; end = $b; block = $t.Substring($a, $b - $a) }
}

$s = Get-Block $src
$d = Get-Block $dst
if ($s.block -ceq $d.block) { Write-Output 'shared block: in sync'; exit 0 }

if ($Push) {
    [IO.File]::WriteAllText($dst, $d.text.Substring(0, $d.start) + $s.block + $d.text.Substring($d.end), $enc)
    Write-Output 'shared block: pushed pattern-mockup.html -> zum_prd_form.html'
    exit 0
}

$sl = $s.block -split "`r?`n"; $dl = $d.block -split "`r?`n"
$n = [Math]::Max($sl.Count, $dl.Count); $shown = 0
for ($i = 0; $i -lt $n -and $shown -lt 10; $i++) {
    $x = if ($i -lt $sl.Count) { $sl[$i] } else { '<end of block>' }
    $y = if ($i -lt $dl.Count) { $dl[$i] } else { '<end of block>' }
    if ($x -cne $y) { Write-Output ("line {0}`n  tool: {1}`n  form: {2}" -f ($i + 1), $x, $y); $shown++ }
}
Write-Output 'shared block: DIFFERS (run with -Push to copy tool -> form)'
exit 1
