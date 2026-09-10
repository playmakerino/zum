# Regenerate the niche / sub-niche pick lists baked into zum_prd_form.html.
#
# Sub niche is a metaobject reference on the product, so the form has to send a real
# metaobject GID - a free-typed name cannot be written. The list is therefore read
# from the live store and inlined into the form. Re-run this whenever sub niches or
# niches are added on zumbamboo.
#
#   powershell -NoProfile -File .\gen-zum-form-data.ps1
#
# Credentials come from %USERPROFILE%\.shopify (see admin/CLAUDE.md). Nothing is printed.

$ErrorActionPreference = 'Stop'

$formPath   = Join-Path $PSScriptRoot 'zum_prd_form.html'
$shop       = '422aa5-ca.myshopify.com'
$apiVersion = '2025-10'

$clientId     = (Get-Content "$env:USERPROFILE\.shopify\zumbamboo.client_id.txt" -Raw).Trim()
$ss           = Get-Content "$env:USERPROFILE\.shopify\zumbamboo.client_secret.enc" | ConvertTo-SecureString
$clientSecret = [System.Net.NetworkCredential]::new('', $ss).Password

$tok = Invoke-RestMethod -Method Post -Uri "https://$shop/admin/oauth/access_token" -Body @{
    grant_type = 'client_credentials'; client_id = $clientId; client_secret = $clientSecret
} -ContentType 'application/x-www-form-urlencoded' -TimeoutSec 30

$headers = @{ 'X-Shopify-Access-Token' = $tok.access_token }
$gqlUri  = "https://$shop/admin/api/$apiVersion/graphql.json"

function Invoke-GQL($query, $variables) {
    $payload = @{ query = $query }
    if ($variables) { $payload['variables'] = $variables }
    Invoke-RestMethod -Method Post -Uri $gqlUri -Headers $headers -ContentType 'application/json' `
        -Body ($payload | ConvertTo-Json -Depth 20 -Compress) -TimeoutSec 90
}

# smoke test - make sure we are talking to the right store before writing anything
$shopName = (Invoke-GQL 'query{ shop{ name } }' $null).data.shop.name
Write-Host "store: $shopName"

# --- sub niches: metaobject type sub_niche -> [name, numeric id] ---
$subs = @(); $cursor = $null
do {
    $q = 'query($c:String){ metaobjects(type:"sub_niche", first:250, after:$c){ pageInfo{ hasNextPage endCursor } nodes{ id displayName } } }'
    $r = Invoke-GQL $q @{ c = $cursor }
    $subs   += $r.data.metaobjects.nodes
    $cursor  = $r.data.metaobjects.pageInfo.endCursor
} while ($r.data.metaobjects.pageInfo.hasNextPage)

$subRows = $subs |
    Where-Object { $_.displayName } |
    Sort-Object displayName |
    ForEach-Object {
        $name = $_.displayName -replace '"', '\"'
        $id   = $_.id -replace '^gid://shopify/Metaobject/', ''
        '["' + $name + '","' + $id + '"]'
    }

# --- niches: distinct values of the niche field across swatch metaobjects ---
$niches = @{}; $cursor = $null
do {
    $q = 'query($c:String){ metaobjects(type:"swatch", first:250, after:$c){ pageInfo{ hasNextPage endCursor } nodes{ field(key:"niche"){ value } } } }'
    $r = Invoke-GQL $q @{ c = $cursor }
    foreach ($n in $r.data.metaobjects.nodes) {
        if ($n.field.value) {
            try { (ConvertFrom-Json $n.field.value) | ForEach-Object { if ($_) { $niches[$_] = 1 } } } catch {}
        }
    }
    $cursor = $r.data.metaobjects.pageInfo.endCursor
} while ($r.data.metaobjects.pageInfo.hasNextPage)

# Metafield custom.niche has an ASCII-apostrophe choice list, but some swatch metaobjects
# store curly apostrophes (Valentine's / St. Patrick's). Normalize so the submitted value
# matches a choice, otherwise productCreate rejects it.
$nicheRows = $niches.Keys | Sort-Object | ForEach-Object {
    $v = $_ -replace [char]0x2019, "'" -replace [char]0x2018, "'"
    '"' + ($v -replace '"', '\"') + '"'
}

Write-Host "niches: $($nicheRows.Count)  sub niches: $($subRows.Count)"

$html = Get-Content $formPath -Raw -Encoding UTF8
$html = [regex]::Replace($html, '(/\*__NICHE_DATA__\*/)\[[^\r\n]*\];',    '${1}[' + ($nicheRows -join ',') + '];')
$html = [regex]::Replace($html, '(/\*__SUBNICHE_DATA__\*/)\[[^\r\n]*\];', '${1}[' + ($subRows   -join ',') + '];')

# UTF-8 without BOM - the page declares <meta charset="UTF-8">
[System.IO.File]::WriteAllText($formPath, $html, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "written: $formPath"
