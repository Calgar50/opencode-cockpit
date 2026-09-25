# InstallBench.ps1 - aides propres au banc d'install.ps1 (lot 6). A charger par dot-sourcing depuis Test-Install.ps1.
# Rien ici n'est un crochet dans le produit : seulement des copies jetables de scripts, des .env de test, des scenarios
# du faux docker (tests/ps51/fake-docker) et des condenses. Aucun secret n'est affiche : les jetons sont compares par
# condense SHA-256 calcule ici.
Set-StrictMode -Version 2.0

# Copie jetable du cockpit : les scripts livres, VERSION et docker-compose.yml, jamais le depot lui-meme.
function New-InstallRoot([string]$Work, [string]$RepoRoot, [string]$Name) {
    $root = Join-Path $Work $Name
    New-Item -ItemType Directory -Path $root -Force | Out-Null
    foreach ($file in @('install.ps1', 'CockpitTls.ps1', 'VERSION', 'docker-compose.yml')) {
        Copy-Item -LiteralPath (Join-Path $RepoRoot $file) -Destination (Join-Path $root $file) -Force
    }
    return $root
}

# .env de test, meme forme que Write-EnvFile (UTF-8 sans BOM, une cle par ligne).
function Set-TestEnvFile([string]$Root, $Values) {
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# Genere par install.ps1. Contient des secrets : ne jamais versionner ni partager ce fichier.')
    foreach ($key in $Values.Keys) { $lines.Add(('{0}={1}' -f $key, $Values[$key])) }
    [System.IO.File]::WriteAllText((Join-Path $Root '.env'), (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
}

# Lecture du .env de test ; [ordered]@{} si le fichier n'existe pas.
function Read-TestEnvFile([string]$Root) {
    $values = [ordered]@{}
    $file = Join-Path $Root '.env'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $values }
    foreach ($line in [System.IO.File]::ReadAllLines($file)) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $index = $line.IndexOf('=')
        $values[$line.Substring(0, $index).Trim()] = $line.Substring($index + 1).Trim()
    }
    return $values
}

function Get-TextDigest([string]$Text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$Text))).Replace('-', '').ToLowerInvariant()) }
    finally { $sha.Dispose() }
}

# Empreinte du fichier .env : 'absent' quand il n'existe pas (aucun contenu n'est affiche).
function Get-EnvFingerprint([string]$Root) {
    $file = Join-Path $Root '.env'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return 'absent' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($file))).Replace('-', '').ToLowerInvariant()) }
    finally { $sha.Dispose() }
}

# Valeur d'une cle du .env de test, '' si absente (jamais affichee par l'appelant pour un secret).
function Get-TestEnvValue($Values, [string]$Key) {
    if ($Values.Contains($Key)) { return [string]$Values[$Key] }
    return ''
}

function New-DockerRule([string]$Match, [string]$Stdout = '', [int]$Code = 0, [string]$StdoutFile = '', $Uses = $null, [switch]$Fail) {
    $rule = [ordered]@{ match = $Match; stdout = $Stdout; code = $Code }
    if ($StdoutFile) { $rule['stdoutFile'] = $StdoutFile }
    if ($null -ne $Uses) { $rule['uses'] = $Uses }
    if ($Fail) { $rule['fail'] = $true }
    return $rule
}

# Jeu de regles d'une execution complete d'install.ps1. Les chemins des fichiers compose contiennent le dossier du
# cockpit : les motifs acceptent n'importe quel chemin apres -f.
function New-InstallDockerRules {
    param([string]$CertFile = '', [string]$JsonFile = '', [string]$ImageVersion = '1.0.6', [string]$ContainerHealth = 'healthy',
        [switch]$ImagesMissing, [switch]$FailPull, [string]$Logs = '')
    $rules = New-Object System.Collections.Generic.List[object]
    $rules.Add((New-DockerRule '^version ' "28.0.1`n"))
    $rules.Add((New-DockerRule '^compose version' "2.33.0`n"))
    $rules.Add((New-DockerRule '^compose -f .* config --format json$' "{`"name`":`"opencode-cockpit`"}`n"))
    $imageId = ''
    $imageCode = 0
    if ($ImagesMissing) { $imageCode = 1 } else { $imageId = "sha256:0123456789abcdef`n" }
    $rules.Add((New-DockerRule '^image inspect --format \{\{\.Id\}\}' $imageId $imageCode))
    $versionOut = ''
    if ($ImageVersion) { $versionOut = "PATH=/usr/bin`nCOCKPIT_VERSION=$ImageVersion`n" }
    $rules.Add((New-DockerRule '^image inspect --format \{\{range \.Config\.Env\}\}' $versionOut))
    if ($FailPull) {
        $rules.Add((New-DockerRule '^compose -f .* (pull|build)$' '' 1))
    } else {
        $rules.Add((New-DockerRule '^compose -f .* (pull|build)$' ''))
    }
    $rules.Add((New-DockerRule '^load ' "Loaded image: opencode-cockpit-app:test`nLoaded image: opencode-cockpit-opencode:test`n"))
    $rules.Add((New-DockerRule '^compose -f .* up --no-start' ''))
    $rules.Add((New-DockerRule '^compose -f .* up -d' ''))
    $rules.Add((New-DockerRule '^run ' ''))
    $rules.Add((New-DockerRule '^compose -f .* ps -q cockpit$' "0123456789abcdef`n"))
    $rules.Add((New-DockerRule '^inspect --format \{\{\.State\.Health\.Status\}\}' ($ContainerHealth + "`n")))
    $rules.Add((New-DockerRule '^compose -f .* exec -T cockpit cat /tls/public/cockpit\.crt$' '' 0 $CertFile))
    $rules.Add((New-DockerRule '^compose -f .* exec -T cockpit cat /tls/public/cockpit-tls\.json$' '' 0 $JsonFile))
    $rules.Add((New-DockerRule '^compose -f .* exec -T cockpit printenv COCKPIT_LOCAL_SCHEME$' "https`n"))
    $rules.Add((New-DockerRule '^compose -f .* logs' $Logs))
    return , @($rules.ToArray())
}

# Ecrit le scenario du faux docker et rend le chemin du journal JSONL.
function Set-InstallDockerScenario([string]$Work, [string]$Name, [object[]]$Rules) {
    $file = Join-Path $Work ('docker-' + $Name + '.json')
    [System.IO.File]::WriteAllText($file, (ConvertTo-Json -Depth 6 @{ rules = @($Rules) }), (New-Object System.Text.UTF8Encoding $false))
    [Environment]::SetEnvironmentVariable('COCKPIT_TEST_DOCKER_SCENARIO', $file, 'Process')
    return ($file + '.jsonl')
}

# Appels consignes par le faux docker : { args ; env ; rule ; code ; forbidden }.
function Get-DockerCalls([string]$Journal) {
    if (-not $Journal -or -not (Test-Path -LiteralPath $Journal -PathType Leaf)) { return @() }
    return @(Get-Content -LiteralPath $Journal | Where-Object { $_ } | ForEach-Object { ConvertFrom-Json $_ })
}

# Vrai si chaque appel 'docker compose <sous-commande>' (hors 'compose version') a recu -f <dossier>\docker-compose.yml.
function Test-ComposeFileAlways([object[]]$Calls, [string]$Root) {
    $expected = Join-Path $Root 'docker-compose.yml'
    foreach ($call in $Calls) {
        $callArgs = @($call.args)
        if ($callArgs.Count -lt 2 -or $callArgs[0] -cne 'compose' -or $callArgs[1] -ceq 'version') { continue }
        if ($callArgs[1] -cne '-f' -or $callArgs[2] -cne $expected) { return $false }
    }
    return $true
}
