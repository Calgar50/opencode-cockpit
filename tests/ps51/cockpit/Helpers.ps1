# Helpers.ps1 - aides propres au banc de cockpit.ps1 (lot 7). Contrat du banc partage : tests/ps51/README.md.
# A charger par dot-sourcing dans Test-Cockpit.ps1. Rien n'est ecrit hors du dossier de travail passe en parametre.
# Aucun crochet dans les scripts livres : installation jetable (copie de cockpit.ps1 et CockpitTls.ps1 + faux install.ps1),
# faux docker du banc partage, espions Spies.ps1, depots git REELS jetables avec un depot nu local comme suivi (P8, P14).
Set-StrictMode -Version 2.0

$CockpitBenchDir = $PSScriptRoot
$CockpitTestsDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$CockpitRepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$CockpitDockerState = @{ Index = 0; Journal = ''; Work = '' }
$CockpitGitExe = $null
# Sortie type de compose config (HTTP_PROXY et http_proxy d'un meme service, comme depuis la 1.0.6) : repetition generale F2.
. (Join-Path $CockpitTestsDir 'ComposeConfig.ps1')

# Execute un bloc : valeurs rendues, texte ecrit par Write-Host (flux 6) et message d'exception.
function Invoke-Captured([scriptblock]$Block) {
    $hostLines = New-Object System.Collections.Generic.List[string]
    $values = New-Object System.Collections.Generic.List[object]
    $message = $null
    try {
        & $Block 6>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.InformationRecord]) { $hostLines.Add([string]$_.MessageData) } else { $values.Add($_) } }
    } catch { $message = $_.Exception.Message }
    return [pscustomobject]@{ Values = $values; Host = ($hostLines -join "`n"); Error = $message }
}

function Set-CockpitTestEnv([string]$Name, [string]$Value) { [Environment]::SetEnvironmentVariable($Name, $Value, 'Process') }

# --- Faux docker (contrat : tests/ps51/README.md) --------------------------------------------------------------------
function New-Rule([string]$Match, [string]$Stdout = '', [int]$Code = 0, $Uses = $null, [string]$StdoutFile = '', [switch]$Fail) {
    $rule = [ordered]@{ match = $Match; stdout = $Stdout; code = $Code }
    if ($null -ne $Uses) { $rule['uses'] = $Uses }
    if ($StdoutFile) { $rule['stdoutFile'] = $StdoutFile }
    if ($Fail) { $rule['fail'] = $true }
    return $rule
}

function Initialize-DockerBench([string]$Work) { $CockpitDockerState.Work = $Work }

function Set-DockerScenario([object[]]$Rules) {
    $CockpitDockerState.Index++
    $file = Join-Path $CockpitDockerState.Work ('docker-{0}.json' -f $CockpitDockerState.Index)
    [System.IO.File]::WriteAllText($file, (ConvertTo-Json -Depth 6 @{ rules = @($Rules) }))
    Set-CockpitTestEnv 'COCKPIT_TEST_DOCKER_SCENARIO' $file
    $CockpitDockerState.Journal = $file + '.jsonl'
}

function Get-DockerJournal {
    if (-not (Test-Path -LiteralPath $CockpitDockerState.Journal)) { return @() }
    return @(Get-Content -LiteralPath $CockpitDockerState.Journal | Where-Object { $_ } | ForEach-Object { ConvertFrom-Json $_ })
}

# Vrai si un appel docker dont les arguments joints correspondent a l'expression a eu lieu.
function Test-DockerCall([string]$Pattern) {
    return (@(Get-DockerJournal | Where-Object { (@($_.args) -join ' ') -cmatch $Pattern }).Count -gt 0)
}

function Get-DockerCallCount([string]$Pattern) {
    return @(Get-DockerJournal | Where-Object { (@($_.args) -join ' ') -cmatch $Pattern }).Count
}

# Regles standard : conteneur cockpit en marche, nom de projet, certificat publie, schema servi.
# -ImageVersion '' : version de l'image illisible ; -Health starting : conteneur pas encore sain.
# -Migration : ligne rendue par le conteneur jetable de la migration du web (A37, restore) ; defaut : rien a migrer.
function New-CockpitDockerRules {
    param([string]$CrtFile = '', [string]$JsonFile = '', [string]$ImageVersion = '1.0.5', [string]$Health = 'healthy',
        [string]$Served = 'https', [string]$Project = 'rg105-l7', [object[]]$Extra,
        [string]$Migration = 'migration-web etat=absent profil=- fichier=- blocs=0 restes=0 sauvegarde=- raison=-', [int]$MigrationCode = 0)
    $id = '0123456789abcdef'
    $rules = @()
    if ($Extra) { $rules += @($Extra) }
    $rules += @((New-Rule '^compose -f \S.* ps -q cockpit$' ($id + "`n")),
        (New-Rule ('^inspect --format \{\{\.Image\}\} ' + $id + '\z') "sha256:image-cockpit`n"))
    if ($ImageVersion) {
        $rules += (New-Rule '^image inspect --format \{\{range \.Config\.Env\}\}\{\{println \.\}\}\{\{end\}\} sha256:image-cockpit\z' ("COCKPIT_VERSION={0}`n" -f $ImageVersion))
    } else {
        $rules += (New-Rule '^image inspect --format \{\{range \.Config\.Env\}\}\{\{println \.\}\}\{\{end\}\} sha256:image-cockpit\z' '' 1)
    }
    $rules += @((New-Rule ('^inspect --format \{\{\.State\.Health\.Status\}\} ' + $id + '\z') ($Health + "`n")),
        (New-Rule '^compose -f \S.* config --format json$' (New-FakeComposeConfigJson $Project)),
        (New-Rule '^compose -f \S.* exec -T cockpit printenv COCKPIT_LOCAL_SCHEME$' ($Served + "`n")),
        (New-Rule '^compose -f \S.* ps$' "NAME  STATUS`ncockpit  Up`n"),
        (New-Rule '^compose -f \S.* (up|stop|start)\b' ''),
        # Migration du web (A37) : AVANT la regle generique '^run --rm ', qui rendrait une sortie vide.
        (New-Rule ('^run --rm --pull never --name ' + $Project + '-migration-web-[0-9a-f]{8} ') ($Migration + "`n") $MigrationCode),
        (New-Rule ('^rm -f ' + $Project + '-migration-web-[0-9a-f]{8}$') ''),
        (New-Rule '^run --rm ' ''))
    if ($CrtFile) { $rules += (New-Rule '^compose -f \S.* exec -T cockpit cat /tls/public/cockpit\.crt$' '' 0 $null $CrtFile) }
    if ($JsonFile) { $rules += (New-Rule '^compose -f \S.* exec -T cockpit cat /tls/public/cockpit-tls\.json$' '' 0 $null $JsonFile) }
    return $rules
}

# --- Installation jetable --------------------------------------------------------------------------------------------
function Write-TestEnvFile([string]$Directory, $Values) {
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# Fichier .env du banc de test : aucune valeur reelle.')
    foreach ($key in @($Values.Keys)) { $lines.Add(('{0}={1}' -f $key, $Values[$key])) }
    [System.IO.File]::WriteAllText((Join-Path $Directory '.env'), (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
}

# Copie de cockpit.ps1 et CockpitTls.ps1, faux install.ps1 qui consigne ses arguments, docker-compose.yml du depot.
function New-TestInstallation {
    param([string]$Work, [string]$Name, $EnvValues, [string]$ScriptsVersion = '1.0.5')
    $dir = Join-Path $Work $Name
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $CockpitRepoRoot 'cockpit.ps1') -Destination (Join-Path $dir 'cockpit.ps1')
    Copy-Item -LiteralPath (Join-Path $CockpitRepoRoot 'CockpitTls.ps1') -Destination (Join-Path $dir 'CockpitTls.ps1')
    Copy-Item -LiteralPath (Join-Path $CockpitRepoRoot 'docker-compose.yml') -Destination (Join-Path $dir 'docker-compose.yml')
    Copy-Item -LiteralPath (Join-Path $CockpitBenchDir 'fake-install.ps1') -Destination (Join-Path $dir 'install.ps1')
    [System.IO.File]::WriteAllText((Join-Path $dir 'VERSION'), ($ScriptsVersion + "`n"), (New-Object System.Text.UTF8Encoding $false))
    Write-TestEnvFile $dir $EnvValues
    return $dir
}

function Get-TestEnvValue([string]$Directory, [string]$Key) {
    foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $Directory '.env'))) {
        if ($line -cmatch ('^\s*{0}=(.*)$' -f [regex]::Escape($Key))) { return $Matches[1].Trim() }
    }
    return ''
}

# Lance cockpit.ps1 de l'installation, espions charges dans la portee de l'appel (P6 : variables non qualifiees).
# -Arguments : parametres de position ; -Parameters : parametres nommes (un tableau ne transmet que des positions).
function Invoke-CockpitScript {
    param([string]$Directory, [string[]]$Arguments = @(), [scriptblock]$Setup, [hashtable]$Parameters = @{})
    . (Join-Path $CockpitTestsDir 'Spies.ps1')
    Reset-SpyState
    if ($null -ne $Setup) { & $Setup }
    $captured = Invoke-Captured { & (Join-Path $Directory 'cockpit.ps1') @Arguments @Parameters }
    return [pscustomobject]@{ Host = $captured.Host; Error = $captured.Error
        Opened = @($SpyState.StartProcessCalls | ForEach-Object { [string]$_.FilePath })
        Prompts = @($SpyState.ReadHostCalls | ForEach-Object { [string]$_ }) }
}

# --- Depots git reels et jetables (P8, P14) ---------------------------------------------------------------------------
function Get-TestGit {
    if (-not $CockpitGitExe) { $script:CockpitGitExe = (Get-Command git.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
    return $CockpitGitExe
}

function Invoke-TestGit([string]$Directory, [string[]]$Arguments, [int]$TimeoutSec = 60) {
    $run = Invoke-CockpitProcess -FilePath (Get-TestGit) -Arguments (@('-C', $Directory) + $Arguments) -TimeoutSec $TimeoutSec
    return $run
}

function Get-TestGitOut([string]$Directory, [string[]]$Arguments) { return (Invoke-TestGit $Directory $Arguments).StdOut.Trim() }

# Depot d'installation reel : commit de la cible (etiquette v<Target>) puis commit courant, suivi par un depot nu local.
# -IgnoredByHead <nom> : fichier suivi par la cible, ignore par la version courante (piege P14).
# -RemovedInHead <nom> : fichier suivi par la cible, supprime par la version courante (conflit avec un fichier non suivi, P8).
# -NoUpstream : aucun suivi distant. -Detached : HEAD detache. -TagOffBranch : etiquette hors de la lignee de HEAD.
function New-TestGitInstallation {
    param([string]$Work, [string]$Name, $EnvValues, [string]$Target = '1.0.4', [string]$ScriptsVersion = '1.0.5',
        [string]$Branch = 'principal', [string]$IgnoredByHead = '', [string]$RemovedInHead = '', [switch]$NoUpstream, [switch]$Detached, [switch]$TagOffBranch, [switch]$NoTag)
    $dir = New-TestInstallation $Work $Name $EnvValues $Target
    $origin = Join-Path $Work ($Name + '-origin.git')
    Invoke-CockpitProcess -FilePath (Get-TestGit) -Arguments @('init', '--bare', '-q', '-b', $Branch, $origin) -TimeoutSec 60 | Out-Null
    Invoke-TestGit $dir @('init', '-q', '-b', $Branch) | Out-Null
    Invoke-TestGit $dir @('config', 'user.email', 'banc@example.invalid') | Out-Null
    Invoke-TestGit $dir @('config', 'user.name', 'banc') | Out-Null
    Invoke-TestGit $dir @('config', 'commit.gpgsign', 'false') | Out-Null
    $ignore = @('.env', 'backups/', 'testinstall/')
    [System.IO.File]::WriteAllText((Join-Path $dir '.gitignore'), (($ignore -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
    if ($IgnoredByHead) { [System.IO.File]::WriteAllText((Join-Path $dir $IgnoredByHead), "version cible`n", (New-Object System.Text.UTF8Encoding $false)) }
    if ($RemovedInHead) { [System.IO.File]::WriteAllText((Join-Path $dir $RemovedInHead), "version cible`n", (New-Object System.Text.UTF8Encoding $false)) }
    Invoke-TestGit $dir @('add', '-A') | Out-Null
    Invoke-TestGit $dir @('commit', '-q', '-m', ('version ' + $Target)) | Out-Null
    if (-not $NoTag -and -not $TagOffBranch) { Invoke-TestGit $dir @('tag', ('v' + $Target)) | Out-Null }
    if ($TagOffBranch) {
        Invoke-TestGit $dir @('checkout', '-q', '-b', 'ailleurs') | Out-Null
        [System.IO.File]::WriteAllText((Join-Path $dir 'ailleurs.txt'), "hors lignee`n", (New-Object System.Text.UTF8Encoding $false))
        Invoke-TestGit $dir @('add', '-A') | Out-Null
        Invoke-TestGit $dir @('commit', '-q', '-m', 'hors lignee') | Out-Null
        Invoke-TestGit $dir @('tag', ('v' + $Target)) | Out-Null
        Invoke-TestGit $dir @('checkout', '-q', $Branch) | Out-Null
    }
    # Commit courant : scripts de la version en cours ; le fichier suivi par la cible devient ignore.
    [System.IO.File]::WriteAllText((Join-Path $dir 'VERSION'), ($ScriptsVersion + "`n"), (New-Object System.Text.UTF8Encoding $false))
    if ($IgnoredByHead) {
        [System.IO.File]::WriteAllText((Join-Path $dir '.gitignore'), (($ignore + @($IgnoredByHead)) -join "`n") + "`n", (New-Object System.Text.UTF8Encoding $false))
        Invoke-TestGit $dir @('rm', '-q', '--cached', $IgnoredByHead) | Out-Null
    }
    if ($RemovedInHead) { Invoke-TestGit $dir @('rm', '-q', '-f', $RemovedInHead) | Out-Null }
    Invoke-TestGit $dir @('add', '-A') | Out-Null
    Invoke-TestGit $dir @('commit', '-q', '-m', ('version ' + $ScriptsVersion)) | Out-Null
    if (-not $NoUpstream) {
        Invoke-TestGit $dir @('remote', 'add', 'origin', $origin) | Out-Null
        Invoke-TestGit $dir @('push', '-q', '-u', 'origin', $Branch) | Out-Null
    }
    if ($Detached) { Invoke-TestGit $dir @('checkout', '-q', '--detach', 'HEAD') | Out-Null }
    return [pscustomobject]@{ Directory = $dir; Origin = $origin; Branch = $Branch }
}

# Depot amont ou un autre poste a publie un commit : 'update' doit le ramener par git pull --ff-only.
function Add-TestUpstreamCommit([string]$Work, [string]$Origin, [string]$Branch, [string]$FileName) {
    $clone = Join-Path $Work ('amont-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    Invoke-CockpitProcess -FilePath (Get-TestGit) -Arguments @('clone', '-q', '-b', $Branch, $Origin, $clone) -TimeoutSec 120 | Out-Null
    Invoke-TestGit $clone @('config', 'user.email', 'banc@example.invalid') | Out-Null
    Invoke-TestGit $clone @('config', 'user.name', 'banc') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $clone $FileName), "publie par un autre poste`n", (New-Object System.Text.UTF8Encoding $false))
    Invoke-TestGit $clone @('add', '-A') | Out-Null
    Invoke-TestGit $clone @('commit', '-q', '-m', 'nouveaute') | Out-Null
    Invoke-TestGit $clone @('push', '-q', 'origin', $Branch) | Out-Null
}

function Get-TestFileHash([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'absent' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($Path))).Replace('-', '')) } finally { $sha.Dispose() }
}
