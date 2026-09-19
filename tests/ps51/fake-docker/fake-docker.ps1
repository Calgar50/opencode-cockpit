# fake-docker.ps1 - faux docker du banc PowerShell 5.1, lance par docker.cmd (contrat : tests/ps51/README.md).
# Scenario JSON designe par COCKPIT_TEST_DOCKER_SCENARIO (variable absente de $CockpitComposeEnvNames) :
#   { "journal": "<chemin, facultatif>", "rules": [ { "match": "<regex>", "stdout": "", "stdoutFile": "", "stderr": "",
#     "code": 0, "uses": <nombre ou null>, "sleepMs": 0, "fail": false } ] }
# "match" : expression reguliere sensible a la casse sur les arguments joints par une espace. Regles essayees dans l'ordre ;
# une regle dont "uses" est epuise est sautee. "fail": true = appel interdit (code 97). Aucune regle : code 99.
# Journal JSONL (defaut <scenario>.jsonl) : { args, env (NOMS des variables de $CockpitComposeEnvNames presentes), rule, code, forbidden }.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# Arguments exacts : la ligne de commande brute est relue selon les regles de CommandLineToArgvW (celles de docker.exe) ;
# powershell.exe -File ne sert qu'a lancer ce script.
function Split-CockpitTestCommandTail([string]$Text) {
    $list = New-Object System.Collections.Generic.List[string]
    $i = 0
    $n = $Text.Length
    while ($true) {
        while ($i -lt $n -and ($Text[$i] -eq ' ' -or $Text[$i] -eq "`t")) { $i++ }
        if ($i -ge $n) { break }
        $builder = New-Object System.Text.StringBuilder
        $quoted = $false
        while ($i -lt $n) {
            $c = $Text[$i]
            if (-not $quoted -and ($c -eq ' ' -or $c -eq "`t")) { break }
            if ($c -eq '\') {
                $count = 0
                while ($i -lt $n -and $Text[$i] -eq '\') { $count++; $i++ }
                if ($i -lt $n -and $Text[$i] -eq '"') {
                    [void]$builder.Append('\', [int][Math]::Floor($count / 2))
                    if ($count % 2 -eq 1) { [void]$builder.Append('"'); $i++ }
                } else {
                    [void]$builder.Append('\', $count)
                }
                continue
            }
            if ($c -eq '"') {
                if ($quoted -and $i + 1 -lt $n -and $Text[$i + 1] -eq '"') { [void]$builder.Append('"'); $i += 2; continue }
                $quoted = -not $quoted
                $i++
                continue
            }
            [void]$builder.Append($c)
            $i++
        }
        $list.Add($builder.ToString())
    }
    return , $list.ToArray()
}

function Get-Field($Object, [string]$Name, $Default) {
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name] -and $null -ne $Object.$Name) { return $Object.$Name }
    return $Default
}

function Write-Bytes([System.IO.Stream]$Stream, [string]$Text) {
    if (-not $Text) { return }
    $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes($Text)
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush()
}

$commandLine = [Environment]::CommandLine
$marker = 'fake-docker.ps1'
$at = $commandLine.IndexOf($marker, [System.StringComparison]::OrdinalIgnoreCase)
$tail = $commandLine.Substring($at + $marker.Length)
if ($tail.StartsWith('"')) { $tail = $tail.Substring(1) }
# La fonction rend le tableau comme UN objet : un @() l'envelopperait dans un tableau d'un seul element.
$argv = [string[]](Split-CockpitTestCommandTail $tail)

. (Join-Path $PSScriptRoot '..\..\..\CockpitTls.ps1')
$present = @([Environment]::GetEnvironmentVariables('Process').Keys)
$envNames = @($CockpitComposeEnvNames | Where-Object { $present -contains $_ })

$stdout = [Console]::OpenStandardOutput()
$stderr = [Console]::OpenStandardError()
$scenarioPath = [Environment]::GetEnvironmentVariable('COCKPIT_TEST_DOCKER_SCENARIO', 'Process')
if (-not $scenarioPath -or -not (Test-Path -LiteralPath $scenarioPath -PathType Leaf)) {
    Write-Bytes $stderr "fake-docker : scenario absent (COCKPIT_TEST_DOCKER_SCENARIO)`n"
    exit 98
}
$scenario = Get-Content -LiteralPath $scenarioPath -Raw | ConvertFrom-Json
$journal = [string](Get-Field $scenario 'journal' ($scenarioPath + '.jsonl'))
$statePath = $scenarioPath + '.state.json'
$used = @{}
if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    foreach ($p in (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).PSObject.Properties) { $used[$p.Name] = [int]$p.Value }
}

$joined = $argv -join ' '
$rules = @(Get-Field $scenario 'rules' @())
$index = $null
$rule = $null
for ($i = 0; $i -lt $rules.Count; $i++) {
    if ($joined -cnotmatch [string](Get-Field $rules[$i] 'match' '(?!)')) { continue }
    $count = 0
    if ($used.ContainsKey([string]$i)) { $count = $used[[string]$i] }
    $limit = Get-Field $rules[$i] 'uses' $null
    if ($null -ne $limit -and $count -ge [int]$limit) { continue }
    $used[[string]$i] = $count + 1
    $index = $i
    $rule = $rules[$i]
    break
}

$code = 99
$out = ''
$err = "fake-docker : aucune regle pour cet appel`n"
$forbidden = $false
if ($null -ne $rule) {
    if ([bool](Get-Field $rule 'fail' $false)) {
        $code = 97
        $err = "fake-docker : appel interdit par le scenario`n"
        $forbidden = $true
    } else {
        $code = [int](Get-Field $rule 'code' 0)
        $out = [string](Get-Field $rule 'stdout' '')
        $file = [string](Get-Field $rule 'stdoutFile' '')
        if ($file) { $out = [System.IO.File]::ReadAllText($file) }
        $err = [string](Get-Field $rule 'stderr' '')
        $sleep = [int](Get-Field $rule 'sleepMs' 0)
        if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }
    }
}
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($statePath, (ConvertTo-Json -Compress $used), $utf8)
$entry = [ordered]@{ args = $argv; env = $envNames; rule = $index; code = $code; forbidden = $forbidden }
[System.IO.File]::AppendAllText($journal, (ConvertTo-Json -Compress -Depth 3 $entry) + "`n", $utf8)
Write-Bytes $stdout $out
Write-Bytes $stderr $err
exit $code
