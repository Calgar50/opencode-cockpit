# Test-Install.ps1 - tests d'install.ps1 sous Windows PowerShell 5.1 (plan v2, lot 6). Sans Pester.
# Usage : powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/ps51/Test-Install.ps1 [-FailFast]
# Banc : copie jetable du cockpit sous %TEMP%, faux docker en tete du PATH du processus, srv-test.mjs sur des ports
# aleatoires (jamais 7777), certificats .NET (New-TestCerts.ps1), espions (Spies.ps1), aides du lot (install/InstallBench.ps1).
# Aucun secret reel : jetons aleatoires propres a l'execution, jamais affiches ; rotations comparees par condense SHA-256.
# Registre : aucune ecriture, seulement les espions Get-ItemProperty et Test-Path.
param([switch]$FailFast)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $Here '..\..'))
. (Join-Path $RepoRoot 'CockpitTls.ps1')
. (Join-Path $Here 'install\InstallBench.ps1')

$Results = @{ Pass = 0; Fail = 0; Failures = (New-Object System.Collections.Generic.List[string]) }
function Assert-Test([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) { $Results.Pass++; return }
    $Results.Fail++
    $Results.Failures.Add(($Name + ' ' + $Detail).Trim())
    Write-Host ('  [KO] {0} {1}' -f $Name, $Detail) -ForegroundColor Red
    if ($FailFast) { throw ('FailFast : ' + $Name) }
}
function Write-Section([string]$Title) { Write-Host ('--- ' + $Title) -ForegroundColor Cyan }

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ('cockpit-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Work | Out-Null
$EnvNames = @('PATH', 'COCKPIT_TEST_DOCKER_SCENARIO', 'COCKPIT_LOCAL_SCHEME', 'COCKPIT_LOCAL_HTTP_CONFIRMED', 'COCKPIT_TOKEN',
    'WORKSPACE_DIR', 'COMPOSE_FILE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY')
$SavedEnv = @{}
foreach ($name in $EnvNames) { $SavedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$Servers = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$Node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
# Sentinelles de reponse : l'espion Read-Host attend $null (entree vide) ou une valeur speciale (mode -NonInteractive).
$AnswerEmpty = '<<banc:vide>>'
$AnswerNoConsole = '<<banc:sans-console>>'

function Set-Env([string]$Name, [string]$Value) { [Environment]::SetEnvironmentVariable($Name, $Value, 'Process') }

function Start-TestServer([hashtable]$Config) {
    $file = Join-Path $Work ('srv-' + [guid]::NewGuid().ToString('N') + '.json')
    [System.IO.File]::WriteAllText($file, (ConvertTo-Json -Depth 6 $Config))
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo -Property @{ FileName = $Node; Arguments = ('"{0}" "{1}"' -f (Join-Path $Here 'srv-test.mjs'), $file)
        UseShellExecute = $false; RedirectStandardInput = $true; RedirectStandardOutput = $true; RedirectStandardError = $true; CreateNoWindow = $true }
    $process = [System.Diagnostics.Process]::Start($startInfo)
    $Servers.Add($process)
    $line = $process.StandardOutput.ReadLine()
    if (-not $line) { throw ('srv-test.mjs ne demarre pas : ' + $process.StandardError.ReadToEnd()) }
    return (ConvertFrom-Json $line).ports
}

# Lance install.ps1 dans la copie jetable, avec les espions charges dans CETTE portee (ils disparaissent au retour).
# Les parametres passent par une table de hachage : un tableau serait pris pour des arguments de position.
# Rend la sortie Write-Host, le message d'exception, le code de sortie et les appels aux espions ; jamais l'URL ouverte.
function Invoke-Install {
    param([string]$Root, [hashtable]$Parameters, [object]$Answers, [object]$Policies)
    . (Join-Path $Here 'Spies.ps1')
    Reset-SpyState
    if ($null -ne $Answers) {
        foreach ($answer in @($Answers)) {
            if ([string]$answer -ceq $AnswerEmpty) { Add-SpyReadHostAnswer $null }
            elseif ([string]$answer -ceq $AnswerNoConsole) { Add-SpyReadHostAnswer $SpyNonInteractive }
            else { Add-SpyReadHostAnswer $answer }
        }
    }
    if ($null -ne $Policies) { foreach ($policy in @($Policies)) { Set-SpyPolicy @policy } }
    $splat = @{}
    if ($null -ne $Parameters) { foreach ($key in @($Parameters.Keys)) { $splat[$key] = $Parameters[$key] } }
    $hostLines = New-Object System.Collections.Generic.List[string]
    $message = $null
    $script = Join-Path $Root 'install.ps1'
    $global:LASTEXITCODE = 0
    try {
        & $script @splat 6>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.InformationRecord]) { $hostLines.Add([string]$_.MessageData) }
        }
    } catch { $message = $_.Exception.Message }
    return [pscustomobject]@{ Host = ($hostLines -join "`n"); Error = $message; ExitCode = $LASTEXITCODE
        ReadHostCalls = @($SpyState.ReadHostCalls | ForEach-Object { [string]$_ })
        StartProcessCalls = @($SpyState.StartProcessCalls | ForEach-Object { [pscustomobject]@{ FilePath = $_.FilePath } }) }
}

# Parametres communs : l'export des autorites Windows n'apporte rien au banc et coute plusieurs secondes.
function New-Params([hashtable]$Extra) {
    $params = @{ SkipCertificates = $true }
    if ($null -ne $Extra) { foreach ($key in @($Extra.Keys)) { $params[$key] = $Extra[$key] } }
    return $params
}

# Strategies simulees : Autorise (aucune valeur), Bloque (0 sans exception), Couvert (0 avec l'exception du port).
function Get-PolicySet([string]$Verdict, [int]$Port) {
    if ($Verdict -ceq 'Autorise') { return @() }
    if ($Verdict -ceq 'Couvert') { return @(@{ Hive = 'HKLM'; Browser = 'Edge'; Name = 'SSLErrorOverrideAllowed'; Value = 0; Origins = @((Get-CockpitBaseUrl 'https' $Port)) }) }
    return @(@{ Hive = 'HKLM'; Browser = 'Edge'; Name = 'SSLErrorOverrideAllowed'; Value = 0; Origins = @('https://intranet.example') })
}

try {
    # --- Banc ---------------------------------------------------------------------------------------------------------
    Write-Section 'Banc : copie du cockpit, certificat, serveurs, faux docker'
    $Root = New-InstallRoot $Work $RepoRoot 'cockpit'
    $Projects = Join-Path $Work 'projets'
    New-Item -ItemType Directory -Path $Projects | Out-Null
    $certDir = Join-Path $Work 'certs-test'
    $CertA = @(& (Join-Path $Here 'New-TestCerts.ps1') -Directory $certDir -Names A)[0]
    $CertFile = Join-Path $certDir 'A.crt'
    $JsonFile = Join-Path $certDir 'A.json'
    [System.IO.File]::WriteAllText($JsonFile, $CertA.JsonText, (New-Object System.Text.UTF8Encoding $false))
    $StateA = ConvertTo-CockpitTlsState $CertA.PemText $CertA.JsonText
    $BehaviorFile = Join-Path $Work 'behavior.json'
    function Set-Behavior([hashtable]$Https) {
        [System.IO.File]::WriteAllText($BehaviorFile, (ConvertTo-Json -Depth 4 @{ A = $Https; plain = @{} }))
    }
    Set-Behavior @{}
    $Ports = Start-TestServer @{ certDir = $certDir; envFile = (Join-Path $Root '.env'); behaviorFile = $BehaviorFile
        listeners = @(@{ name = 'A'; kind = 'https'; cert = 'A' }, @{ name = 'plain'; kind = 'http' }) }
    Assert-Test 'banc : aucun port 7777' (@($Ports.PSObject.Properties | Where-Object { $_.Value -eq 7777 }).Count -eq 0)
    Set-Env 'PATH' ((Join-Path $Here 'fake-docker') + ';' + $SavedEnv['PATH'])
    $Version = (Get-Content -LiteralPath (Join-Path $Root 'VERSION') -TotalCount 1).Trim()
    $HttpsUrl = Get-CockpitBaseUrl 'https' $Ports.A
    $HttpUrl = Get-CockpitBaseUrl 'http' $Ports.plain

    # Remet la copie jetable a l'etat voulu : .env choisi (ou absent), aucun dossier cree par une execution precedente.
    function Reset-Root($EnvValues) {
        foreach ($item in @('.env', 'certs', 'archives', 'docker-compose.override.yml')) {
            $path = Join-Path $Root $item
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
        }
        if ($null -ne $EnvValues) { Set-TestEnvFile $Root $EnvValues }
    }
    # .env type d'une installation existante ($null pour Scheme et ConfirmedAt : cles absentes, comme une 1.0.4).
    function New-BaseEnv([int]$Port, $Scheme, $ConfirmedAt, [string]$Token, [string]$Version, [string]$InstallMode = 'Build') {
        $values = [ordered]@{ WORKSPACE_DIR = ($Projects -replace '\\', '/'); ARCHIVE_DIR = './archives'; COCKPIT_PORT = [string]$Port
            COCKPIT_TOKEN = $Token; OPENCODE_SERVER_PASSWORD = (New-CockpitChallenge); HTTP_PROXY = ''; HTTPS_PROXY = ''; NO_PROXY = ''
            COCKPIT_TLS_INSECURE = '0'; TZ = 'Europe/Paris'; COCKPIT_PROJECT_CONFIG = '0'; COCKPIT_GITHUB_ENTERPRISE_DOMAIN = ''
            COCKPIT_COPILOT_API_URL = ''; COCKPIT_OPENCODE_IMAGE = 'opencode-cockpit/opencode:local'
            COCKPIT_APP_IMAGE = 'opencode-cockpit/app:local'; COCKPIT_INSTALL_MODE = $InstallMode; COCKPIT_VERSION = $Version }
        if ($null -ne $Scheme) { $values['COCKPIT_LOCAL_SCHEME'] = $Scheme }
        if ($null -ne $ConfirmedAt) { $values['COCKPIT_LOCAL_HTTP_CONFIRMED'] = $ConfirmedAt }
        return $values
    }
    $ConfirmedAt = '2026-09-15T10:32:00Z'

    # --- Incompatibilites de parametres, avant toute commande docker ---------------------------------------------------
    Write-Section 'Incompatibilites de parametres'
    $incompatibles = @(
        @{ Name = 'http-https'; Params = @{ Http = $true; Https = $true }; Text = '-Http et -Https' },
        @{ Name = 'preflight-http'; Params = @{ TlsPreflight = $true; Http = $true }; Text = '-TlsPreflight ne modifie rien' },
        @{ Name = 'accept-http'; Params = @{ AcceptBrowserBlock = $true; Http = $true }; Text = '-AcceptBrowserBlock ne concerne que' })
    foreach ($case in $incompatibles) {
        Reset-Root $null
        $journal = Set-InstallDockerScenario $Work ('incompat-' + $case.Name) @((New-DockerRule '.' '' 0 '' $null -Fail))
        $result = Invoke-Install -Root $Root -Parameters $case.Params
        $calls = @(Get-DockerCalls $journal)
        Assert-Test ('incompatibilite {0} : arret avec message' -f $case.Name) ($null -ne $result.Error -and $result.Error.Contains($case.Text)) ([string]$result.Error)
        Assert-Test ('incompatibilite {0} : aucun appel docker' -f $case.Name) ($calls.Count -eq 0) ([string]$calls.Count)
        Assert-Test ('incompatibilite {0} : aucun .env ecrit' -f $case.Name) ((Get-EnvFingerprint $Root) -ceq 'absent')
    }

    # --- -TlsPreflight : sans Docker, sans ecriture ---------------------------------------------------------------------
    Write-Section '-TlsPreflight (aucune ecriture, aucun appel docker)'
    Reset-Root (New-BaseEnv $Ports.A 'https' '' (New-CockpitChallenge) $Version)
    $before = Get-EnvFingerprint $Root
    $journal = Set-InstallDockerScenario $Work 'preflight-autorise' @((New-DockerRule '.' '' 0 '' $null -Fail))
    $result = Invoke-Install -Root $Root -Parameters @{ TlsPreflight = $true } -Policies (Get-PolicySet 'Autorise' $Ports.A)
    Assert-Test '-TlsPreflight : aucun appel docker' (@(Get-DockerCalls $journal).Count -eq 0)
    Assert-Test '-TlsPreflight : .env inchange' ((Get-EnvFingerprint $Root) -ceq $before)
    Assert-Test '-TlsPreflight : code 0 quand la strategie autorise' ($result.ExitCode -eq 0) ([string]$result.ExitCode)
    Assert-Test '-TlsPreflight : verdict affiche' ($result.Host.Contains('Verdict Edge : Autorise')) $result.Host
    Assert-Test '-TlsPreflight : voie de verification affichee' ($result.Host.Contains('Voie qui serait utilisee :'))
    Assert-Test '-TlsPreflight : mode lu affiche' ($result.Host.Contains('Mode d acces inscrit dans .env : https'))
    Assert-Test '-TlsPreflight : strategie Edge absente nommee, jamais une valeur vide' ($result.Host.Contains('Edge SSLErrorOverrideAllowed : absente (non lue)'))
    Assert-Test '-TlsPreflight : edge://policy rappele' ($result.Host.Contains('edge://policy'))

    $journal = Set-InstallDockerScenario $Work 'preflight-bloque' @((New-DockerRule '.' '' 0 '' $null -Fail))
    $result = Invoke-Install -Root $Root -Parameters @{ TlsPreflight = $true } -Policies (Get-PolicySet 'Bloque' $Ports.A)
    Assert-Test '-TlsPreflight : code 3 quand Edge bloque' ($result.ExitCode -eq 3) ([string]$result.ExitCode)
    Assert-Test '-TlsPreflight : verdict Bloque affiche' ($result.Host.Contains('Verdict Edge : Bloque'))
    Assert-Test '-TlsPreflight : .env toujours inchange' ((Get-EnvFingerprint $Root) -ceq $before)
    Assert-Test '-TlsPreflight : aucune ouverture' ($result.StartProcessCalls.Count -eq 0)

    # --- Installation neuve en HTTPS ------------------------------------------------------------------------------------
    Write-Section 'Installation neuve en HTTPS'
    $newWorkspace = Join-Path $Work 'projets-neufs'
    if (Test-Path -LiteralPath $newWorkspace) { Remove-Item -LiteralPath $newWorkspace -Recurse -Force }
    Reset-Root $null
    $journal = Set-InstallDockerScenario $Work 'neuve-https' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ Port = $Ports.A; WorkspaceDir = $newWorkspace }) `
        -Answers @('o') -Policies (Get-PolicySet 'Autorise' $Ports.A)
    $envAfter = Read-TestEnvFile $Root
    $token = Get-TestEnvValue $envAfter 'COCKPIT_TOKEN'
    Assert-Test 'neuve HTTPS : aucune exception' ($null -eq $result.Error) ([string]$result.Error)
    Assert-Test 'neuve HTTPS : adresse https annoncee' ($result.Host.Contains('Cockpit disponible sur ' + $HttpsUrl)) $result.Host
    Assert-Test 'neuve HTTPS : empreinte du certificat A affichee' ($result.Host.Contains($StateA.Sha256))
    Assert-Test 'neuve HTTPS : mode https ecrit dans .env' ((Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_SCHEME') -ceq 'https')
    Assert-Test 'neuve HTTPS : date de confirmation vide mais presente' ($envAfter.Contains('COCKPIT_LOCAL_HTTP_CONFIRMED') -and (Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_HTTP_CONFIRMED') -ceq '')
    Assert-Test 'neuve HTTPS : jeton au format genere' (Test-CockpitGeneratedToken $token)
    Assert-Test 'neuve HTTPS : dossier des projets cree' (Test-Path -LiteralPath $newWorkspace -PathType Container)
    Assert-Test 'neuve HTTPS : une seule ouverture' ($result.StartProcessCalls.Count -eq 1) ([string]$result.StartProcessCalls.Count)
    if ($result.StartProcessCalls.Count -eq 1) {
        $url = [string]$result.StartProcessCalls[0].FilePath
        $expected = '^' + [regex]::Escape($HttpsUrl) + '/auth\?k=[0-9a-f]{64}\.[0-9a-f]{64}\z'
        Assert-Test 'neuve HTTPS : lien au format ticket' ($url -cmatch $expected)
        Assert-Test 'neuve HTTPS : signature du ticket verifiable' ($url -cmatch '/auth\?k=([0-9a-f]{64})\.([0-9a-f]{64})\z' -and (Get-CockpitHmacHex $token 'auth-ticket' $Matches[1]) -ceq $Matches[2])
        Assert-Test 'neuve HTTPS : lien absent de la sortie' (-not $result.Host.Contains('/auth?k='))
    }
    Assert-Test 'neuve HTTPS : jeton absent de la sortie' (-not $result.Host.Contains($token))
    Assert-Test 'neuve HTTPS : preuve du jeton annoncee' ($result.Host.Contains('preuve du jeton verifies'))
    Assert-Test 'neuve HTTPS : texte A1 de l annexe A' ($result.Host.Contains("Le navigateur va afficher `"Votre connexion n'est pas privee`" : c'est attendu (certificat local,") `
        -and $result.Host.Contains("non approuve par Windows). Comparez l'empreinte, puis Avance > Continuer vers 127.0.0.1 (non securise).") `
        -and $result.Host.Contains('Le lien ouvert est a usage unique (10 minutes) et ne contient pas votre jeton.') `
        -and $result.Host.Contains("Utilisez 127.0.0.1 (localhost redemande l'avertissement). L'ancienne adresse en http:// ne repond plus.")) $result.Host
    $calls = @(Get-DockerCalls $journal)
    $joined = @($calls | ForEach-Object { (@($_.args) -join ' ') })
    # Migration du web (fiche MW 1.2) : --pull never sur les run de chown et de chmod, une image absente n'est jamais tiree.
    Assert-Test 'neuve HTTPS : volume cockpit-tls prepare avec l image app, sans -R' (@($joined | Where-Object { $_ -cmatch '^run --rm --pull never --network none --user 0 --entrypoint chown -v opencode-cockpit_cockpit-tls:/tls opencode-cockpit/app:local 1000:1000 /tls\z' }).Count -eq 1) ($joined -join ' | ')
    Assert-Test 'neuve HTTPS : droits 0700 du volume cockpit-tls' (@($joined | Where-Object { $_ -cmatch '^run --rm --pull never --network none --user 0 --entrypoint chmod -v opencode-cockpit_cockpit-tls:/tls opencode-cockpit/app:local 0700 /tls\z' }).Count -eq 1)
    Assert-Test 'neuve HTTPS : volumes partages sans reseau' (@($joined | Where-Object { $_ -cmatch '^run --rm --pull never --network none --user 0 --entrypoint chown -v opencode-cockpit_oc-config' }).Count -eq 1)
    Assert-Test 'neuve HTTPS : aucun run sans --pull never (image jamais tiree d un registre)' (@($joined | Where-Object { $_ -cmatch '^run ' -and $_ -cnotmatch '^run --rm --pull never ' }).Count -eq 0) ($joined -join ' | ')
    Assert-Test 'neuve HTTPS : volume neuf, migration du web sans rien afficher' (-not $result.Host.Contains('Passage a la 1.1.0') -and @($joined | Where-Object { $_ -cmatch ('^run --rm --pull never --name ' + $MigrationNamePattern + ' ') }).Count -eq 1) ($joined -join ' | ')
    Assert-Test 'neuve HTTPS : -f docker-compose.yml sur chaque commande compose' (Test-ComposeFileAlways $calls $Root)

    # --- Garde Edge : entree en HTTPS bloquee -----------------------------------------------------------------------------
    Write-Section 'Garde Edge (entree en HTTPS)'
    Reset-Root $null
    $journal = Set-InstallDockerScenario $Work 'neuve-bloque' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ Port = $Ports.A }) -Policies (Get-PolicySet 'Bloque' $Ports.A)
    $calls = @(Get-DockerCalls $journal)
    Assert-Test 'neuve + Bloque : A2 affiche' ($result.Host.Contains("Edge interdit de passer l'avertissement de certificat sur ce poste")) $result.Host
    Assert-Test 'neuve + Bloque : les deux issues sont donnees' ($result.Host.Contains('SSLErrorOverrideAllowedForOrigins = ' + $HttpsUrl) -and $result.Host.Contains('.\install.ps1 -Http'))
    Assert-Test 'neuve + Bloque : A19, un seul arret' ($result.Error -ceq $CockpitA19) ([string]$result.Error)
    Assert-Test 'neuve + Bloque : aucune question posee' ($result.ReadHostCalls.Count -eq 0) ($result.ReadHostCalls -join ' | ')
    Assert-Test 'neuve + Bloque : aucun .env' ((Get-EnvFingerprint $Root) -ceq 'absent')
    Assert-Test 'neuve + Bloque : aucun dossier cree' (-not (Test-Path -LiteralPath (Join-Path $Root 'certs')) -and -not (Test-Path -LiteralPath (Join-Path $Root 'archives')))
    Assert-Test 'neuve + Bloque : seulement version et compose version' ((@($calls | ForEach-Object { @($_.args)[0] }) -join ',') -ceq 'version,compose') (@($calls | ForEach-Object { (@($_.args) -join ' ') }) -join ' | ')

    Reset-Root $null
    $journal = Set-InstallDockerScenario $Work 'neuve-accept' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ Port = $Ports.A; WorkspaceDir = $Projects; AcceptBrowserBlock = $true }) `
        -Policies (Get-PolicySet 'Bloque' $Ports.A)
    Assert-Test '-AcceptBrowserBlock : installation menee a bien' ($null -eq $result.Error -and $result.Host.Contains('Cockpit disponible sur ' + $HttpsUrl)) ([string]$result.Error)
    Assert-Test '-AcceptBrowserBlock : strategie signalee comme ignoree' ($result.Host.Contains('ignoree (-AcceptBrowserBlock)'))
    Assert-Test '-AcceptBrowserBlock : A2-Open avant l ouverture' ($result.Host.Contains("passage de l'avertissement interdit pour " + $HttpsUrl))
    Assert-Test '-AcceptBrowserBlock : le lien s ouvre quand meme' ($result.StartProcessCalls.Count -eq 1)
    $envAfter = Read-TestEnvFile $Root
    Assert-Test '-AcceptBrowserBlock : jamais memorise dans .env' (-not (@($envAfter.Keys) -join ',').Contains('ACCEPT'))

    # --- Confirmation du mode HTTP ----------------------------------------------------------------------------------------
    Write-Section 'Mode HTTP : confirmation'
    $refus = @(@{ Name = 'http-seul'; Answer = 'HTTP' }, @{ Name = 'casse'; Answer = 'http en clair' }, @{ Name = 'vide'; Answer = $AnswerEmpty })
    foreach ($case in $refus) {
        Reset-Root $null
        $journal = Set-InstallDockerScenario $Work ('http-refus-' + $case.Name) (New-InstallDockerRules $CertFile $JsonFile)
        $result = Invoke-Install -Root $Root -Parameters (New-Params @{ Port = $Ports.plain; Http = $true }) -Answers @($case.Answer) -Policies (Get-PolicySet 'Bloque' $Ports.plain)
        Assert-Test ('-Http refuse ({0}) : arret sans modification' -f $case.Name) ($result.Error -ceq 'Installation annulee : mode HTTP non confirme. Aucun fichier modifie, mode inchange.') ([string]$result.Error)
        Assert-Test ('-Http refuse ({0}) : aucun .env' -f $case.Name) ((Get-EnvFingerprint $Root) -ceq 'absent')
        Assert-Test ('-Http refuse ({0}) : ecran A5 affiche' -f $case.Name) ($result.Host.Contains('Mode HTTP local demande (-Http)') -and $result.Host.Contains('Ce qui circule EN CLAIR'))
    }
    Reset-Root $null
    $journal = Set-InstallDockerScenario $Work 'http-sans-console' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ Port = $Ports.plain; Http = $true }) -Answers @($AnswerNoConsole) -Policies (Get-PolicySet 'Bloque' $Ports.plain)
    Assert-Test '-Http sans console : arret explicite' ($result.Error -ceq 'Installation annulee : la confirmation du mode HTTP exige une console interactive (tapez HTTP EN CLAIR).') ([string]$result.Error)
    Assert-Test '-Http sans console : aucun .env' ((Get-EnvFingerprint $Root) -ceq 'absent')

    Write-Section 'Mode HTTP : confirmation acceptee'
    Reset-Root $null
    $journal = Set-InstallDockerScenario $Work 'http-accepte' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ Port = $Ports.plain; WorkspaceDir = $Projects; Http = $true }) `
        -Answers @('HTTP EN CLAIR') -Policies (Get-PolicySet 'Bloque' $Ports.plain)
    $envAfter = Read-TestEnvFile $Root
    $httpToken = Get-TestEnvValue $envAfter 'COCKPIT_TOKEN'
    $confirmed = Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_HTTP_CONFIRMED'
    Assert-Test '-Http accepte : aucune exception' ($null -eq $result.Error) ([string]$result.Error)
    Assert-Test '-Http accepte : mode http dans .env' ((Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_SCHEME') -ceq 'http')
    Assert-Test '-Http accepte : date de confirmation conforme aux vecteurs' ((Test-CockpitConfirmedAt $confirmed) -and $confirmed -cmatch '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\z') $confirmed
    Assert-Test '-Http accepte : A5 puis A6 puis A7' ($result.Host.Contains('Mode HTTP local demande (-Http)') -and $result.Host.Contains('MODE HTTP LOCAL (confirme le') -and $result.Host.Contains('Cockpit disponible sur ' + $HttpUrl + ' (mode HTTP local, preuve du jeton verifiee'))
    Assert-Test '-Http accepte : une ouverture en http' ($result.StartProcessCalls.Count -eq 1 -and ([string]$result.StartProcessCalls[0].FilePath).StartsWith($HttpUrl + '/auth?k=')) ([string]$result.StartProcessCalls.Count)
    Assert-Test '-Http accepte : jeton absent de la sortie' (-not $result.Host.Contains($httpToken))
    Assert-Test '-Http accepte : aucune empreinte de certificat annoncee' (-not $result.Host.Contains('Empreinte SHA-256'))

    Reset-Root $null
    $journal = Set-InstallDockerScenario $Work 'http-nobrowser' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ Port = $Ports.plain; WorkspaceDir = $Projects; Http = $true; NoBrowser = $true }) `
        -Answers @('HTTP EN CLAIR') -Policies (Get-PolicySet 'Bloque' $Ports.plain)
    Assert-Test '-Http -NoBrowser : aucune ouverture' ($result.StartProcessCalls.Count -eq 0) ([string]$result.StartProcessCalls.Count)
    Assert-Test '-Http -NoBrowser : A6 et A7 affiches' ($result.Host.Contains('MODE HTTP LOCAL (confirme le') -and $result.Host.Contains('mode HTTP local, preuve du jeton verifiee'))
    Assert-Test '-Http -NoBrowser : commande d ouverture donnee' ($result.Host.Contains('Ouvrir : .\cockpit.ps1 open'))
    $openLines = [regex]::Matches($result.Host, [regex]::Escape('Ouvrir : .\cockpit.ps1 open')).Count
    Assert-Test '-Http -NoBrowser : commande d ouverture donnee une seule fois' ($openLines -eq 1) ([string]$openLines)

    # --- Relance en mode HTTP (chemin de cockpit.ps1 update) --------------------------------------------------------------
    Write-Section 'Relance en mode HTTP (update)'
    $httpEnv = New-BaseEnv $Ports.plain 'http' $ConfirmedAt (New-CockpitChallenge) $Version
    Reset-Root $httpEnv
    $tokenBefore = Get-TextDigest (Get-TestEnvValue (Read-TestEnvFile $Root) 'COCKPIT_TOKEN')
    $journal = Set-InstallDockerScenario $Work 'http-relance' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoBrowser = $true }) -Policies (Get-PolicySet 'Bloque' $Ports.plain)
    $envAfter = Read-TestEnvFile $Root
    Assert-Test 'relance HTTP : aucune question' ($result.ReadHostCalls.Count -eq 0) ($result.ReadHostCalls -join ' | ')
    Assert-Test 'relance HTTP : mode et date conserves' ((Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_SCHEME') -ceq 'http' -and (Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_HTTP_CONFIRMED') -ceq $ConfirmedAt)
    Assert-Test 'relance HTTP : jeton inchange' ((Get-TextDigest (Get-TestEnvValue $envAfter 'COCKPIT_TOKEN')) -ceq $tokenBefore)
    Assert-Test 'relance HTTP : A6 rappele malgre -NoBrowser' ($result.Host.Contains('MODE HTTP LOCAL (confirme le 2026-09-15 10:32 UTC avec -Http)')) $result.Host
    Assert-Test 'relance HTTP : A6b absent quand Edge bloque' (-not $result.Host.Contains('Edge semble autoriser'))
    $openLines = [regex]::Matches($result.Host, [regex]::Escape('Ouvrir : .\cockpit.ps1 open')).Count
    Assert-Test 'relance HTTP (update) : commande d ouverture donnee une seule fois' ($openLines -eq 1) ([string]$openLines)

    Reset-Root $httpEnv
    $journal = Set-InstallDockerScenario $Work 'http-relance-autorise' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoBrowser = $true }) -Policies (Get-PolicySet 'Autorise' $Ports.plain)
    Assert-Test 'relance HTTP + Autorise : A6b propose le retour en HTTPS' ($result.Host.Contains('Edge semble autoriser') -and $result.Host.Contains('.\install.ps1 -Https')) $result.Host

    Reset-Root $httpEnv
    $journal = Set-InstallDockerScenario $Work 'http-deja' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ Http = $true; NoBrowser = $true }) -Policies (Get-PolicySet 'Bloque' $Ports.plain)
    Assert-Test '-Http sur une installation deja en HTTP : aucune confirmation' ($result.ReadHostCalls.Count -eq 0 -and $result.Host.Contains('Deja en mode HTTP local (confirme le ' + $ConfirmedAt + ')')) $result.Host

    Reset-Root (New-BaseEnv $Ports.A 'https' '' (New-CockpitChallenge) $Version)
    $journal = Set-InstallDockerScenario $Work 'https-deja' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ Https = $true; NoBrowser = $true }) -Policies (Get-PolicySet 'Autorise' $Ports.A)
    Assert-Test '-Https sur une installation deja en HTTPS : rien a changer' ($result.Host.Contains('Deja en HTTPS local : rien a changer.') -and -not $result.Host.Contains('Retour en HTTPS : nouveau jeton')) $result.Host
    $openLines = [regex]::Matches($result.Host, [regex]::Escape('Ouvrir : .\cockpit.ps1 open')).Count
    Assert-Test 'HTTPS -NoBrowser : commande d ouverture donnee une seule fois' ($openLines -eq 1) ([string]$openLines)

    # --- Retour en HTTPS ---------------------------------------------------------------------------------------------------
    Write-Section 'Retour en HTTPS (-Https)'
    Reset-Root $httpEnv
    $before = Get-EnvFingerprint $Root
    $journal = Set-InstallDockerScenario $Work 'retour-bloque' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ Https = $true }) -Policies (Get-PolicySet 'Bloque' $Ports.plain)
    Assert-Test '-Https + Bloque : A2 puis A19' ($result.Error -ceq $CockpitA19 -and $result.Host.Contains("Edge interdit de passer l'avertissement")) ([string]$result.Error)
    Assert-Test '-Https + Bloque : .env inchange (toujours HTTP)' ((Get-EnvFingerprint $Root) -ceq $before)

    Reset-Root (New-BaseEnv $Ports.A 'http' $ConfirmedAt (New-CockpitChallenge) $Version)
    $tokenBefore = Get-TextDigest (Get-TestEnvValue (Read-TestEnvFile $Root) 'COCKPIT_TOKEN')
    $journal = Set-InstallDockerScenario $Work 'retour-autorise' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ Https = $true; NoBrowser = $true }) -Policies (Get-PolicySet 'Autorise' $Ports.A)
    $envAfter = Read-TestEnvFile $Root
    Assert-Test '-Https : mode https et date videe' ((Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_SCHEME') -ceq 'https' -and (Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_HTTP_CONFIRMED') -ceq '')
    Assert-Test '-Https : nouveau jeton au format genere' ((Get-TextDigest (Get-TestEnvValue $envAfter 'COCKPIT_TOKEN')) -cne $tokenBefore -and (Test-CockpitGeneratedToken (Get-TestEnvValue $envAfter 'COCKPIT_TOKEN')))
    Assert-Test '-Https : aucune question' ($result.ReadHostCalls.Count -eq 0) ($result.ReadHostCalls -join ' | ')
    Assert-Test '-Https : A12 affiche' ($result.Host.Contains("Retour en HTTPS : nouveau jeton genere ; l'ancien, dont la session a circule en clair, est revoque (reconnexion necessaire).") `
        -and $result.Host.Contains("Si c'est l'empreinte deja acceptee dans votre navigateur il y a moins de 7 jours, aucun avertissement ;") `
        -and $result.Host.Contains("comparez l'empreinte avant de continuer.")) $result.Host
    Assert-Test '-Https : plus aucun rappel de mode HTTP' (-not $result.Host.Contains('MODE HTTP LOCAL'))

    # --- K2-1 : une installation deja en HTTPS n'est jamais bloquee (M11) ----------------------------------------------------
    Write-Section 'K2-1 M11 : mise a jour d une installation deja en HTTPS'
    Reset-Root (New-BaseEnv $Ports.A 'https' '' (New-CockpitChallenge) $Version)
    $tokenBefore = Get-TextDigest (Get-TestEnvValue (Read-TestEnvFile $Root) 'COCKPIT_TOKEN')
    $journal = Set-InstallDockerScenario $Work 'm11' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{}) -Policies (Get-PolicySet 'Bloque' $Ports.A)
    $envAfter = Read-TestEnvFile $Root
    Assert-Test 'K2-1 M11 : A2-Reste, pas d arret' ($null -eq $result.Error -and $result.Host.Contains('Votre cockpit est deja en HTTPS : la mise a jour continue')) ([string]$result.Error)
    Assert-Test 'K2-1 M11 : aucune proposition de passer en HTTP' (-not $result.Host.Contains('Choisir le mode HTTP local'))
    Assert-Test 'K2-1 M11 : ouverture avec A2-Open' ($result.StartProcessCalls.Count -eq 1 -and $result.Host.Contains("passage de l'avertissement interdit pour " + $HttpsUrl))
    Assert-Test 'K2-1 M11 : jeton inchange' ((Get-TextDigest (Get-TestEnvValue $envAfter 'COCKPIT_TOKEN')) -ceq $tokenBefore)
    Assert-Test 'K2-1 M11 : mode https conserve' ((Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_SCHEME') -ceq 'https')

    # --- Jeton hors format ---------------------------------------------------------------------------------------------------
    Write-Section 'Jeton hors du format genere'
    Reset-Root (New-BaseEnv $Ports.A 'https' '' ('a' * 40) $Version)
    $journal = Set-InstallDockerScenario $Work 'jeton-40' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoBrowser = $true }) -Policies (Get-PolicySet 'Autorise' $Ports.A)
    $envAfter = Read-TestEnvFile $Root
    Assert-Test 'jeton de 40 caracteres : remplace par un jeton genere' (Test-CockpitGeneratedToken (Get-TestEnvValue $envAfter 'COCKPIT_TOKEN'))
    Assert-Test 'jeton de 40 caracteres : phrase dediee' ($result.Host.Contains('Nouveau jeton de connexion genere (l ancien n avait pas le format attendu)')) $result.Host

    # --- .env invalides -------------------------------------------------------------------------------------------------------
    Write-Section 'Mode d acces invalide dans .env (A18)'
    $invalides = @(
        @{ Name = 'http-sans-date'; Scheme = 'http'; At = ''; Problem = 'COCKPIT_LOCAL_SCHEME=http sans date de confirmation valable' },
        @{ Name = 'htps'; Scheme = 'htps'; At = ''; Problem = 'valeur non reconnue' },
        @{ Name = 'guillemets'; Scheme = '"http"'; At = $ConfirmedAt; Problem = 'valeur non reconnue' },
        @{ Name = '30-fevrier'; Scheme = 'http'; At = '2026-02-30T00:00:00Z'; Problem = 'COCKPIT_LOCAL_SCHEME=http sans date de confirmation valable' })
    foreach ($case in $invalides) {
        Reset-Root (New-BaseEnv $Ports.A $case.Scheme $case.At (New-CockpitChallenge) $Version)
        $before = Get-EnvFingerprint $Root
        $journal = Set-InstallDockerScenario $Work ('invalide-' + $case.Name) (New-InstallDockerRules $CertFile $JsonFile)
        $result = Invoke-Install -Root $Root -Parameters (New-Params @{}) -Policies (Get-PolicySet 'Autorise' $Ports.A)
        Assert-Test ('.env invalide ({0}) : A18' -f $case.Name) ($result.Host.Contains("Mode d'acces invalide dans .env : " + $case.Problem)) $result.Host
        Assert-Test ('.env invalide ({0}) : A19' -f $case.Name) ($result.Error -ceq $CockpitA19) ([string]$result.Error)
        Assert-Test ('.env invalide ({0}) : .env inchange' -f $case.Name) ((Get-EnvFingerprint $Root) -ceq $before)
        Assert-Test ('.env invalide ({0}) : valeur lue jamais recopiee' -f $case.Name) (-not $result.Host.Contains('htps') -and -not $result.Host.Contains('"http"'))
    }

    # --- K1-2 : migration depuis la 1.0.4 ---------------------------------------------------------------------------------------
    Write-Section 'K1-2 migration HTTPS (M1) et relance'
    $migrationEnv = New-BaseEnv $Ports.A $null $null (New-CockpitChallenge) '1.0.4'
    Reset-Root $migrationEnv
    $tokenBefore = Get-TextDigest (Get-TestEnvValue (Read-TestEnvFile $Root) 'COCKPIT_TOKEN')
    $journal = Set-InstallDockerScenario $Work 'migration-https' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoBrowser = $true }) -Policies (Get-PolicySet 'Autorise' $Ports.A)
    $envAfter = Read-TestEnvFile $Root
    Assert-Test 'K1-2 migration HTTPS : aucune exception' ($null -eq $result.Error) ([string]$result.Error)
    Assert-Test 'K1-2 migration HTTPS : mode https' ((Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_SCHEME') -ceq 'https')
    Assert-Test 'K1-2 migration HTTPS : jeton remplace' ((Get-TextDigest (Get-TestEnvValue $envAfter 'COCKPIT_TOKEN')) -cne $tokenBefore -and (Test-CockpitGeneratedToken (Get-TestEnvValue $envAfter 'COCKPIT_TOKEN')))
    Assert-Test 'K1-2 migration HTTPS : COCKPIT_PREVIOUS_* ecrites' ((Get-TestEnvValue $envAfter 'COCKPIT_PREVIOUS_VERSION') -ceq '1.0.4' -and (Get-TestEnvValue $envAfter 'COCKPIT_PREVIOUS_APP_IMAGE') -ceq 'opencode-cockpit/app:local' -and (Get-TestEnvValue $envAfter 'COCKPIT_PREVIOUS_INSTALL_MODE') -ceq 'Build')
    Assert-Test 'K1-2 migration HTTPS : A3 meme avec -NoBrowser' ($result.Host.Contains('Passage a la ' + $Version + ' : HTTPS local') -and $result.Host.Contains('Retour a la version precedente (1.0.4)')) $result.Host
    Assert-Test 'K1-2 migration HTTPS : COCKPIT_VERSION mis a jour' ((Get-TestEnvValue $envAfter 'COCKPIT_VERSION') -ceq $Version)

    $previousDigest = Get-TextDigest (Get-TestEnvValue $envAfter 'COCKPIT_TOKEN')
    $previousKeys = @(@('COCKPIT_PREVIOUS_VERSION', 'COCKPIT_PREVIOUS_APP_IMAGE', 'COCKPIT_PREVIOUS_OPENCODE_IMAGE', 'COCKPIT_PREVIOUS_INSTALL_MODE') |
        ForEach-Object { Get-TestEnvValue $envAfter $_ })
    $journal = Set-InstallDockerScenario $Work 'migration-relance' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoBrowser = $true }) -Policies (Get-PolicySet 'Autorise' $Ports.A)
    $envRelance = Read-TestEnvFile $Root
    $previousAfter = @(@('COCKPIT_PREVIOUS_VERSION', 'COCKPIT_PREVIOUS_APP_IMAGE', 'COCKPIT_PREVIOUS_OPENCODE_IMAGE', 'COCKPIT_PREVIOUS_INSTALL_MODE') |
        ForEach-Object { Get-TestEnvValue $envRelance $_ })
    Assert-Test 'relance apres M1 : jeton inchange' ((Get-TextDigest (Get-TestEnvValue $envRelance 'COCKPIT_TOKEN')) -ceq $previousDigest)
    Assert-Test 'relance apres M1 : cles PREVIOUS inchangees' (($previousAfter -join '|') -ceq ($previousKeys -join '|')) ($previousAfter -join '|')
    Assert-Test 'relance apres M1 : aucun message de migration' (-not $result.Host.Contains('Passage a la '))

    # --- K2-2 : message regroupe (M6 et M5) ------------------------------------------------------------------------------------
    Write-Section 'K2-2 message regroupe (mode Load sans archive)'
    $loadEnv = New-BaseEnv $Ports.A $null $null (New-CockpitChallenge) '1.0.4' 'Load'
    Reset-Root $loadEnv
    $before = Get-EnvFingerprint $Root
    $journal = Set-InstallDockerScenario $Work 'm6' (New-InstallDockerRules $CertFile $JsonFile '1.0.4')
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{}) -Policies (Get-PolicySet 'Bloque' $Ports.A)
    Assert-Test 'K2-2 M6 : A2 present' ($result.Host.Contains("Edge interdit de passer l'avertissement de certificat sur ce poste"))
    Assert-Test 'K2-2 M6 : A-Load present' ($result.Host.Contains('Mode Load : image opencode-cockpit/app:local en version 1.0.4, version ' + $Version + ' requise')) $result.Host
    Assert-Test 'K2-2 M6 : A2-Load present' ($result.Host.Contains("quelle que soit l'issue choisie, ajoutez -ImagesArchive"))
    Assert-Test 'K2-2 M6 : A2-Update present' ($result.Host.Contains('Si vous venez de lancer .\cockpit.ps1 update'))
    Assert-Test 'K2-2 M6 : un seul arret (A19)' ($result.Error -ceq $CockpitA19) ([string]$result.Error)
    Assert-Test 'K2-2 M6 : .env identique' ((Get-EnvFingerprint $Root) -ceq $before)
    Assert-Test 'K2-2 M6 : aucun passage en HTTP' (-not $result.Host.Contains('Mode HTTP local demande'))
    Assert-Test 'K2-2 M6 : aucun avertissement de continuation' (-not $result.Host.Contains('la mise a jour continue'))

    Reset-Root $loadEnv
    $journal = Set-InstallDockerScenario $Work 'm5' (New-InstallDockerRules $CertFile $JsonFile '1.0.4')
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{}) -Policies (Get-PolicySet 'Autorise' $Ports.A)
    Assert-Test 'K2-2 M5 : A-Load et A2-Update, sans A2' ($result.Host.Contains('Mode Load : image') -and $result.Host.Contains('Si vous venez de lancer .\cockpit.ps1 update') -and -not $result.Host.Contains("Edge interdit de passer l'avertissement")) $result.Host
    Assert-Test 'K2-2 M5 : un seul arret (A19)' ($result.Error -ceq $CockpitA19) ([string]$result.Error)
    Assert-Test 'K2-2 M5 : A2-Load absent' (-not $result.Host.Contains("quelle que soit l'issue choisie"))

    Reset-Root (New-BaseEnv $Ports.A $null $null (New-CockpitChallenge) '1.0.4' 'Load')
    $journal = Set-InstallDockerScenario $Work 'm5-absentes' (New-InstallDockerRules $CertFile $JsonFile '1.0.4' 'healthy' -ImagesMissing)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{}) -Policies (Get-PolicySet 'Autorise' $Ports.A)
    Assert-Test 'mode Load : images absentes signalees' ($result.Host.Contains('Mode Load : images absentes.') -and $result.Error -ceq $CockpitA19) $result.Host

    # --- K1-2 : migration vers le mode HTTP (M3) et .env 1.0.4 deja en http (M10) --------------------------------------------------
    Write-Section 'K1-2 migration HTTP (M3) et M10'
    Reset-Root (New-BaseEnv $Ports.plain $null $null (New-CockpitChallenge) '1.0.4')
    $tokenBefore = Get-TextDigest (Get-TestEnvValue (Read-TestEnvFile $Root) 'COCKPIT_TOKEN')
    $journal = Set-InstallDockerScenario $Work 'm3' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ Http = $true; NoBrowser = $true }) -Answers @('HTTP EN CLAIR') -Policies (Get-PolicySet 'Bloque' $Ports.plain)
    $envAfter = Read-TestEnvFile $Root
    Assert-Test 'K1-2 migration HTTP : mode http confirme' ((Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_SCHEME') -ceq 'http' -and (Test-CockpitConfirmedAt (Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_HTTP_CONFIRMED')))
    Assert-Test 'K1-2 migration HTTP : jeton remplace' ((Get-TextDigest (Get-TestEnvValue $envAfter 'COCKPIT_TOKEN')) -cne $tokenBefore)
    Assert-Test 'K1-2 migration HTTP : COCKPIT_PREVIOUS_* ecrites' ((Get-TestEnvValue $envAfter 'COCKPIT_PREVIOUS_VERSION') -ceq '1.0.4')
    Assert-Test 'K1-2 migration HTTP : A3-HTTP affiche' ($result.Host.Contains('Passage a la ' + $Version + ' en mode HTTP local') -and $result.Host.Contains('Adresse inchangee : ' + $HttpUrl + ' (vos favoris restent valables).') `
        -and $result.Host.Contains("En mode HTTP, la connexion se fait uniquement par .\cockpit.ps1 open (l'ecran de connexion ne demande pas le jeton).") `
        -and $result.Host.Contains("Un bandeau permanent rappelle le mode HTTP dans l'interface.")) $result.Host

    Reset-Root (New-BaseEnv $Ports.plain 'http' $ConfirmedAt (New-CockpitChallenge) '1.0.4')
    $tokenBefore = Get-TextDigest (Get-TestEnvValue (Read-TestEnvFile $Root) 'COCKPIT_TOKEN')
    $journal = Set-InstallDockerScenario $Work 'm10' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoBrowser = $true }) -Policies (Get-PolicySet 'Bloque' $Ports.plain)
    $envAfter = Read-TestEnvFile $Root
    Assert-Test 'K1-2 M10 : aucune question' ($result.ReadHostCalls.Count -eq 0) ($result.ReadHostCalls -join ' | ')
    Assert-Test 'K1-2 M10 : mode http et date conserves' ((Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_SCHEME') -ceq 'http' -and (Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_HTTP_CONFIRMED') -ceq $ConfirmedAt)
    Assert-Test 'K1-2 M10 : jeton remplace' ((Get-TextDigest (Get-TestEnvValue $envAfter 'COCKPIT_TOKEN')) -cne $tokenBefore)
    Assert-Test 'K1-2 M10 : A6 puis A3-HTTP' ($result.Host.Contains('MODE HTTP LOCAL (confirme le 2026-09-15 10:32 UTC avec -Http)') -and $result.Host.Contains('Passage a la ' + $Version + ' en mode HTTP local')) $result.Host

    # --- Restauration apres un echec de telechargement ----------------------------------------------------------------------------
    Write-Section 'Restauration de .env apres un echec de compose pull'
    Reset-Root (New-BaseEnv $Ports.A 'https' '' (New-CockpitChallenge) $Version 'Pull')
    $envBefore = Read-TestEnvFile $Root
    $tokenBefore = Get-TextDigest (Get-TestEnvValue $envBefore 'COCKPIT_TOKEN')
    $journal = Set-InstallDockerScenario $Work 'pull-echec' (New-InstallDockerRules $CertFile $JsonFile '1.0.5' 'healthy' -FailPull)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ Http = $true }) -Answers @('HTTP EN CLAIR') -Policies (Get-PolicySet 'Bloque' $Ports.A)
    $envAfter = Read-TestEnvFile $Root
    Assert-Test 'echec de pull : exception remontee' ($null -ne $result.Error) ([string]$result.Error)
    Assert-Test 'echec de pull : mode d acces restaure' ((Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_SCHEME') -ceq 'https' -and (Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_HTTP_CONFIRMED') -ceq '') ((Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_SCHEME'))
    Assert-Test 'echec de pull : jeton restaure' ((Get-TextDigest (Get-TestEnvValue $envAfter 'COCKPIT_TOKEN')) -ceq $tokenBefore)
    Assert-Test 'echec de pull : version restauree' ((Get-TestEnvValue $envAfter 'COCKPIT_VERSION') -ceq (Get-TestEnvValue $envBefore 'COCKPIT_VERSION'))
    Assert-Test 'echec de pull : images precedentes conservees' ((Get-TestEnvValue $envAfter 'COCKPIT_APP_IMAGE') -ceq (Get-TestEnvValue $envBefore 'COCKPIT_APP_IMAGE'))
    Assert-Test 'echec de pull : aucune ouverture' ($result.StartProcessCalls.Count -eq 0)

    # --- Preuve du jeton fausse -------------------------------------------------------------------------------------------------
    Write-Section 'Preuve du jeton fausse apres healthy (A4-Preuve)'
    Reset-Root (New-BaseEnv $Ports.A 'https' '' (New-CockpitChallenge) $Version)
    Set-Behavior @{ proof = 'bad' }
    $journal = Set-InstallDockerScenario $Work 'preuve-fausse' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{}) -Policies (Get-PolicySet 'Autorise' $Ports.A)
    Set-Behavior @{}
    Assert-Test 'preuve fausse : A4-Preuve' ($result.Host.Contains("ne prouve pas qu'il connait le jeton de ce cockpit") -and $result.Host.Contains("Programme a l'ecoute sur ce port :")) $result.Host
    Assert-Test 'preuve fausse : aucune ouverture' ($result.StartProcessCalls.Count -eq 0) ([string]$result.StartProcessCalls.Count)
    Assert-Test 'preuve fausse : aucune adresse annoncee comme disponible' (-not $result.Host.Contains('Cockpit disponible'))

    # --- K1-1 : variables du shell et fichier override ----------------------------------------------------------------------------
    Write-Section 'K1-1 variables et override'
    Reset-Root (New-BaseEnv $Ports.A 'https' '' (New-CockpitChallenge) $Version)
    [System.IO.File]::WriteAllText((Join-Path $Root 'docker-compose.override.yml'), "services:`n  cockpit:`n    environment:`n      COCKPIT_LOCAL_SCHEME: http`n")
    $intrus = [ordered]@{ COCKPIT_LOCAL_SCHEME = 'http'; COCKPIT_LOCAL_HTTP_CONFIRMED = $ConfirmedAt; COCKPIT_TOKEN = ('b' * 64); WORKSPACE_DIR = 'C:/ailleurs'; COMPOSE_FILE = 'autre.yml' }
    foreach ($name in @($intrus.Keys)) { Set-Env $name $intrus[$name] }
    $journal = Set-InstallDockerScenario $Work 'k1-1' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoBrowser = $true }) -Policies (Get-PolicySet 'Autorise' $Ports.A)
    $calls = @(Get-DockerCalls $journal)
    $envAfter = Read-TestEnvFile $Root
    Assert-Test 'K1-1 : -f docker-compose.yml sur chaque commande compose' (Test-ComposeFileAlways $calls $Root) (@($calls | ForEach-Object { (@($_.args) -join ' ') }) -join ' | ')
    Assert-Test 'K1-1 : aucune variable de compose vue par docker' (@($calls | Where-Object { @($_.env).Count -gt 0 }).Count -eq 0) (@($calls | ForEach-Object { @($_.env) -join ',' }) -join ' | ')
    Assert-Test 'K1-1 : mode de .env applique, pas celui du shell' ((Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_SCHEME') -ceq 'https' -and (Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_HTTP_CONFIRMED') -ceq '')
    Assert-Test 'K1-1 : dossier des projets de .env conserve' ((Get-TestEnvValue $envAfter 'WORKSPACE_DIR') -ceq ($Projects -replace '\\', '/'))
    $restored = @(@($intrus.Keys) | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') -cne $intrus[$_] })
    Assert-Test 'K1-1 : variables du processus de test restaurees' ($restored.Count -eq 0) ($restored -join ',')
    foreach ($name in @($intrus.Keys)) { Set-Env $name $SavedEnv[$name] }
    Remove-Item -LiteralPath (Join-Path $Root 'docker-compose.override.yml') -Force

    # --- -NoStart par mode ------------------------------------------------------------------------------------------------------
    Write-Section '-NoStart par mode'
    Reset-Root (New-BaseEnv $Ports.A 'https' '' (New-CockpitChallenge) $Version)
    $journal = Set-InstallDockerScenario $Work 'nostart-https' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoStart = $true }) -Policies (Get-PolicySet 'Autorise' $Ports.A)
    Assert-Test '-NoStart HTTPS : message propre au mode' ($result.Host.Contains('.\cockpit.ps1 open (verification HTTPS : empreinte et preuve du jeton)')) $result.Host
    Assert-Test '-NoStart HTTPS : aucun demarrage' (@(Get-DockerCalls $journal | Where-Object { (@($_.args) -join ' ') -cmatch ' up -d' }).Count -eq 0)

    Reset-Root $httpEnv
    $journal = Set-InstallDockerScenario $Work 'nostart-http' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoStart = $true }) -Policies (Get-PolicySet 'Bloque' $Ports.plain)
    Assert-Test '-NoStart HTTP : message propre au mode' ($result.Host.Contains('.\cockpit.ps1 open (verification : preuve du jeton)') -and -not $result.Host.Contains('verification HTTPS')) $result.Host
    Assert-Test '-NoStart HTTP : A6 affiche' ($result.Host.Contains('MODE HTTP LOCAL (confirme le'))

    # --- 1.0.6 : mise a jour depuis la 1.0.5 (chemin de cockpit.ps1 update), contrat ResteHttp ------------------------------------
    Write-Section '1.0.6 : mise a jour depuis la 1.0.5 en HTTP (ResteHttp) et en HTTPS'
    $env105Http = New-BaseEnv $Ports.plain 'http' $ConfirmedAt (New-CockpitChallenge) '1.0.5'
    Assert-Test '1.0.6 ResteHttp : transition calculee pour une 1.0.5 en HTTP sans -Http' ((Get-CockpitTransition -Mode (Get-CockpitLocalMode $env105Http) -IsNew $false -IsMigration $false) -ceq 'ResteHttp')
    Reset-Root $env105Http
    $envBefore = Read-TestEnvFile $Root
    $tokenBefore = Get-TextDigest (Get-TestEnvValue $envBefore 'COCKPIT_TOKEN')
    $passwordBefore = Get-TextDigest (Get-TestEnvValue $envBefore 'OPENCODE_SERVER_PASSWORD')
    $journal = Set-InstallDockerScenario $Work 'maj-105-http' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoBrowser = $true }) -Policies (Get-PolicySet 'Bloque' $Ports.plain)
    $envAfter = Read-TestEnvFile $Root
    Assert-Test '1.0.6 ResteHttp : aucune exception' ($null -eq $result.Error) ([string]$result.Error)
    Assert-Test '1.0.6 ResteHttp : aucune question (jamais le passage force en HTTPS)' ($result.ReadHostCalls.Count -eq 0) ($result.ReadHostCalls -join ' | ')
    Assert-Test '1.0.6 ResteHttp : mode http et date de confirmation conserves' ((Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_SCHEME') -ceq 'http' -and (Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_HTTP_CONFIRMED') -ceq $ConfirmedAt)
    Assert-Test '1.0.6 ResteHttp : jeton de connexion inchange (aucune reconnexion)' ((Get-TextDigest (Get-TestEnvValue $envAfter 'COCKPIT_TOKEN')) -ceq $tokenBefore)
    Assert-Test '1.0.6 ResteHttp : cockpit annonce en http, sans migration' ($result.Host.Contains('Cockpit disponible sur ' + $HttpUrl + ' (mode HTTP local') -and -not $result.Host.Contains('Passage a la ') -and -not $result.Host.Contains('Empreinte SHA-256')) $result.Host
    Assert-Test '1.0.6 ResteHttp : aucune cle COCKPIT_PREVIOUS_* ecrite' (-not (@($envAfter.Keys) -join ',').Contains('COCKPIT_PREVIOUS_'))
    Assert-Test '1.0.6 : version 1.0.6 inscrite' ((Get-TestEnvValue $envAfter 'COCKPIT_VERSION') -ceq $Version -and $Version -ceq '1.0.6') $Version
    Assert-Test '1.0.6 : mot de passe interne d opencode renouvele une fois' ((Get-TextDigest (Get-TestEnvValue $envAfter 'OPENCODE_SERVER_PASSWORD')) -cne $passwordBefore -and (Get-TestEnvValue $envAfter 'OPENCODE_SERVER_PASSWORD') -cmatch '^[0-9a-f]{64}\z')
    Assert-Test '1.0.6 : renouvellement annonce sans la valeur' ($result.Host.Contains("Mot de passe interne d'opencode renouvele") -and -not $result.Host.Contains((Get-TestEnvValue $envAfter 'OPENCODE_SERVER_PASSWORD')))

    $passwordKept = Get-TextDigest (Get-TestEnvValue $envAfter 'OPENCODE_SERVER_PASSWORD')
    $journal = Set-InstallDockerScenario $Work 'maj-106-relance' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoBrowser = $true }) -Policies (Get-PolicySet 'Bloque' $Ports.plain)
    $envAfter = Read-TestEnvFile $Root
    Assert-Test '1.0.6 relance : mot de passe interne garde' ((Get-TextDigest (Get-TestEnvValue $envAfter 'OPENCODE_SERVER_PASSWORD')) -ceq $passwordKept)
    Assert-Test '1.0.6 relance : toujours en http' ((Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_SCHEME') -ceq 'http' -and $result.ReadHostCalls.Count -eq 0)

    Reset-Root (New-BaseEnv $Ports.A 'https' '' (New-CockpitChallenge) '1.0.5')
    $tokenBefore = Get-TextDigest (Get-TestEnvValue (Read-TestEnvFile $Root) 'COCKPIT_TOKEN')
    $journal = Set-InstallDockerScenario $Work 'maj-105-https' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoBrowser = $true }) -Policies (Get-PolicySet 'Autorise' $Ports.A)
    $envAfter = Read-TestEnvFile $Root
    Assert-Test '1.0.6 ResteHttps : aucune exception, adresse https annoncee' ($null -eq $result.Error -and $result.Host.Contains('Cockpit disponible sur ' + $HttpsUrl)) ([string]$result.Error)
    Assert-Test '1.0.6 ResteHttps : mode et jeton inchanges, sans migration' ((Get-TestEnvValue $envAfter 'COCKPIT_LOCAL_SCHEME') -ceq 'https' -and (Get-TextDigest (Get-TestEnvValue $envAfter 'COCKPIT_TOKEN')) -ceq $tokenBefore -and -not $result.Host.Contains('Passage a la '))

    Write-Section '1.0.6 : mode Load sans archive avec des images 1.0.5 (relais absent)'
    $loadHttp = New-BaseEnv $Ports.plain 'http' $ConfirmedAt (New-CockpitChallenge) '1.0.5' 'Load'
    Reset-Root $loadHttp
    $before = Get-EnvFingerprint $Root
    $journal = Set-InstallDockerScenario $Work 'maj-105-load' (New-InstallDockerRules $CertFile $JsonFile '1.0.5')
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoBrowser = $true }) -Policies (Get-PolicySet 'Bloque' $Ports.plain)
    Assert-Test '1.0.6 Load : arret avant toute modification, archive 1.0.6 demandee' ($result.Error -ceq $CockpitA19 -and $result.Host.Contains('Mode Load : image opencode-cockpit/app:local en version 1.0.5, version ' + $Version + ' requise') -and $result.Host.Contains('opencode-cockpit-images-' + $Version + '.tar.gz')) $result.Host
    Assert-Test '1.0.6 Load : .env identique, toujours en HTTP, aucune question' ((Get-EnvFingerprint $Root) -ceq $before -and $result.ReadHostCalls.Count -eq 0 -and -not $result.Host.Contains("Edge interdit de passer l'avertissement"))
    Assert-Test '1.0.6 Load : aucun demarrage' (@(Get-DockerCalls $journal | Where-Object { (@($_.args) -join ' ') -cmatch ' up ' }).Count -eq 0)

    Write-Section '1.0.6 : domaine GitHub Enterprise (seul domaine ouvert par le relais)'
    $gheEnv = New-BaseEnv $Ports.A 'https' '' (New-CockpitChallenge) $Version
    foreach ($bad in @('10.1.2.3', 'acme', 'acme.ghe.com/x', 'acme.ghe.com:8443', '*.ghe.com')) {
        $gheEnv['COCKPIT_GITHUB_ENTERPRISE_DOMAIN'] = $bad
        Reset-Root $gheEnv
        $before = Get-EnvFingerprint $Root
        $journal = Set-InstallDockerScenario $Work 'ghe-refus' (New-InstallDockerRules $CertFile $JsonFile)
        $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoBrowser = $true }) -Policies (Get-PolicySet 'Autorise' $Ports.A)
        Assert-Test ('domaine GitHub Enterprise refuse : {0}' -f $bad) ($null -ne $result.Error -and $result.Error.Contains('COCKPIT_GITHUB_ENTERPRISE_DOMAIN refuse') -and (Get-EnvFingerprint $Root) -ceq $before) ([string]$result.Error)
    }
    $gheEnv['COCKPIT_GITHUB_ENTERPRISE_DOMAIN'] = 'https://Acme.GHE.com/'
    Reset-Root $gheEnv
    $journal = Set-InstallDockerScenario $Work 'ghe-normalise' (New-InstallDockerRules $CertFile $JsonFile)
    $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoBrowser = $true }) -Policies (Get-PolicySet 'Autorise' $Ports.A)
    Assert-Test 'domaine GitHub Enterprise normalise comme le cockpit' ($null -eq $result.Error -and (Get-TestEnvValue (Read-TestEnvFile $Root) 'COCKPIT_GITHUB_ENTERPRISE_DOMAIN') -ceq 'acme.ghe.com') ([string]$result.Error)

    Write-Section '1.0.6 : proxy d entreprise que le relais sait chainer (http:// seulement)'
    $proxyEnv = New-BaseEnv $Ports.A 'https' '' (New-CockpitChallenge) $Version
    $proxyCases = @(
        @{ Proxy = 'https://agent:MOTDEPASSE-PROXY@proxy.example:8443'; Scheme = 'https' },
        @{ Proxy = 'SOCKS5://proxy.example:1080'; Scheme = 'socks5' },
        @{ Proxy = 'http://agent:MOTDEPASSE-PROXY@proxy.example:8080'; Scheme = '' },
        @{ Proxy = 'HTTP://proxy.example:8080'; Scheme = '' },
        @{ Proxy = 'proxy.example:8080'; Scheme = '' })
    foreach ($case in $proxyCases) {
        Reset-Root $proxyEnv
        $journal = Set-InstallDockerScenario $Work 'proxy-schema' (New-InstallDockerRules $CertFile $JsonFile)
        $result = Invoke-Install -Root $Root -Parameters (New-Params @{ NoBrowser = $true; Proxy = $case.Proxy }) -Policies (Get-PolicySet 'Autorise' $Ports.A)
        $warned = $result.Host.Contains("le relais d'opencode ne sait passer que par un proxy http://")
        $label = ($case.Proxy -replace 'MOTDEPASSE-PROXY', '****')
        if ($case.Scheme) {
            Assert-Test ('proxy {0} : avertissement du relais, schema cite' -f $label) ($null -eq $result.Error -and $warned -and $result.Host.Contains(('Proxy en {0}://' -f $case.Scheme))) ([string]$result.Error)
        } else {
            Assert-Test ('proxy {0} : aucun avertissement du relais' -f $label) ($null -eq $result.Error -and -not $warned) ([string]$result.Error)
        }
        Assert-Test ('proxy {0} : identifiants jamais affiches' -f $label) (-not $result.Host.Contains('MOTDEPASSE-PROXY'))
    }

    # --- Migration du web 1.0.x -> 1.1.0 (decision A37, fiche MW : T6) ---------------------------------------------------------------
    Write-Section 'Migration du web (A37) : conteneur jetable, verdict sur stdout seul, jamais bloquante'
    $MigrationNo = 0
    # Appel direct de la bibliotheque (chargee en tete de ce fichier) avec un scenario neuf du faux docker.
    function Invoke-MigrationUnit([object[]]$Rules, [string]$Image = 'opencode-cockpit/app:local', [string]$Project = 'opencode-cockpit', [string]$Contexte = 'install', [int]$TimeoutSec = 120) {
        $script:MigrationNo++
        $journal = Set-InstallDockerScenario $Work ('migration-unite-' + $MigrationNo) $Rules
        $threw = $null
        $value = $null
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        try { $value = Invoke-CockpitWebMigration -Root $Root -Project $Project -Image $Image -Contexte $Contexte -TimeoutSec $TimeoutSec } catch { $threw = $_.Exception.Message }
        $watch.Stop()
        return [pscustomobject]@{ Value = $value; Threw = $threw; Seconds = $watch.Elapsed.TotalSeconds; Journal = $journal
            Calls = @(Get-DockerCalls $journal | ForEach-Object { (@($_.args) -join ' ') }); Raw = @(Get-DockerCalls $journal) }
    }
    function Get-MigrationFields($Value) {
        if ($null -eq $Value) { return 'null' }
        return ('{0}|{1}|{2}|{3}|{4}|{5}|{6}' -f $Value.Etat, $Value.Profil, $Value.Fichier, $Value.Blocs, $Value.Restes, $Value.Sauvegarde, $Value.Raison)
    }
    $LineMigre = 'migration-web etat=migre profil=prudent fichier=opencode.jsonc blocs=1 restes=0 sauvegarde=opencode.jsonc.avant-1.1.0 raison=-'
    $ExactRun = '^run --rm --pull never --name (' + $MigrationNamePattern + ') --network none --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 -v opencode-cockpit_oc-config:/oc-config --entrypoint node opencode-cockpit/app:local --no-warnings server/migrate-oc-config.ts /oc-config\z'

    $expectedLine = 'docker run --rm --pull never --name opencode-cockpit-migration-web-0123abcd --network none --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 -v opencode-cockpit_oc-config:/oc-config --entrypoint node opencode-cockpit/app:local --no-warnings server/migrate-oc-config.ts /oc-config'
    $argsLine = $null
    try { $argsLine = 'docker ' + ((Get-CockpitWebMigrationArgs 'opencode-cockpit' 'opencode-cockpit/app:local' 'opencode-cockpit-migration-web-0123abcd') -join ' ') } catch { $argsLine = $_.Exception.Message }
    Assert-Test 'migration : commande exacte de la fiche MW 1.2' ($argsLine -ceq $expectedLine) ([string]$argsLine)

    $unit = Invoke-MigrationUnit @(New-MigrationDockerRules ($LineMigre + "`n"))
    Assert-Test 'migration : verdict migre lu sur stdout' ((Get-MigrationFields $unit.Value) -ceq 'migre|prudent|opencode.jsonc|1|0|opencode.jsonc.avant-1.1.0|-') ((Get-MigrationFields $unit.Value) + ' ' + [string]$unit.Threw)
    Assert-Test 'migration : un seul appel, ligne exacte, nom tire au hasard' ($unit.Calls.Count -eq 1 -and $unit.Calls[0] -cmatch $ExactRun) ($unit.Calls -join ' | ')
    Assert-Test 'migration : aucune variable transmise au conteneur (ni -e, ni --env-file, ni variable de compose)' ($unit.Raw.Count -eq 1 -and @($unit.Raw[0].env).Count -eq 0 -and -not ($unit.Calls[0] -cmatch '(^| )(-e|--env|--env-file)( |=)')) ($unit.Calls -join ' | ')
    $second = Invoke-MigrationUnit @(New-MigrationDockerRules ($LineMigre + "`n"))
    Assert-Test 'migration : deux appels, deux noms differents' ($unit.Calls.Count -eq 1 -and $second.Calls.Count -eq 1 -and $unit.Calls[0] -cmatch $ExactRun -and ($first = $Matches[1]) -and $second.Calls[0] -cmatch $ExactRun -and $Matches[1] -cne $first) ($second.Calls -join ' | ')

    $unit = Invoke-MigrationUnit @(New-MigrationDockerRules ($LineMigre + "`n") 0 "(node:1) Warning: avertissement de Node`nWARNING: avertissement de Docker`n")
    Assert-Test 'migration : avertissement sur stderr et ligne stdout valide -> migre (stderr ignore)' ((Get-MigrationFields $unit.Value) -ceq 'migre|prudent|opencode.jsonc|1|0|opencode.jsonc.avant-1.1.0|-') (Get-MigrationFields $unit.Value)
    $unit = Invoke-MigrationUnit @(New-MigrationDockerRules "`n" 0 ($LineMigre + "`n"))
    Assert-Test 'migration : ligne valide sur stderr seulement -> sortie-inattendue (verdict sur stdout seul)' ($null -ne $unit.Value -and $unit.Value.Etat -ceq 'erreur' -and $unit.Value.Raison -ceq 'sortie-inattendue') (Get-MigrationFields $unit.Value)

    $inattendues = @(
        @{ Name = 'deux lignes'; Stdout = ($LineMigre + "`n" + $LineMigre + "`n"); Code = 0 },
        @{ Name = 'texte libre'; Stdout = "Unable to find image`n"; Code = 0 },
        @{ Name = 'ligne tronquee'; Stdout = 'migration-web etat=migre profil=prudent'; Code = 0 },
        @{ Name = 'raison hors format'; Stdout = 'migration-web etat=erreur profil=- fichier=- blocs=0 restes=0 sauvegarde=- raison=Raison_Libre'; Code = 1 },
        @{ Name = 'migre avec le code 1'; Stdout = $LineMigre; Code = 1 },
        @{ Name = 'erreur avec le code 0'; Stdout = 'migration-web etat=erreur profil=- fichier=- blocs=0 restes=0 sauvegarde=- raison=root'; Code = 0 })
    foreach ($case in $inattendues) {
        $unit = Invoke-MigrationUnit @(New-MigrationDockerRules ($case.Stdout + "`n") $case.Code)
        $runs = @($unit.Calls | Where-Object { $_ -cmatch $ExactRun })
        $name = ''
        if ($runs.Count -eq 1 -and $runs[0] -cmatch $ExactRun) { $name = $Matches[1] }
        Assert-Test ('migration, sortie inattendue ({0}) : erreur sortie-inattendue, sans exception' -f $case.Name) ($null -eq $unit.Threw -and $null -ne $unit.Value -and $unit.Value.Etat -ceq 'erreur' -and $unit.Value.Raison -ceq 'sortie-inattendue') ((Get-MigrationFields $unit.Value) + ' ' + [string]$unit.Threw)
        Assert-Test ('migration, sortie inattendue ({0}) : docker rm -f du meme conteneur avant de rendre la main' -f $case.Name) ($name -and @($unit.Calls | Where-Object { $_ -ceq ('rm -f ' + $name) }).Count -eq 1) ($unit.Calls -join ' | ')
    }
    $unit = Invoke-MigrationUnit @(New-MigrationDockerRules "`n" 125 "docker: Error response from daemon: No such image`n")
    Assert-Test 'migration : image absente (--pull never, code 125) -> erreur docker, conteneur retire' ($null -ne $unit.Value -and $unit.Value.Etat -ceq 'erreur' -and $unit.Value.Raison -ceq 'docker' -and @($unit.Calls | Where-Object { $_ -cmatch ('^rm -f ' + $MigrationNamePattern + '$') }).Count -eq 1) ((Get-MigrationFields $unit.Value) + ' ' + ($unit.Calls -join ' | '))
    $unit = Invoke-MigrationUnit @(New-MigrationDockerRules 'migration-web etat=erreur profil=- fichier=- blocs=0 restes=0 sauvegarde=- raison=root' 1)
    Assert-Test 'migration : erreur rendue par le script (code 1 coherent) -> sa raison, aucun rm -f' ((Get-MigrationFields $unit.Value) -ceq 'erreur|-|-|0|0|-|root' -and @($unit.Calls | Where-Object { $_ -cmatch '^rm -f ' }).Count -eq 0) ((Get-MigrationFields $unit.Value) + ' ' + ($unit.Calls -join ' | '))

    $unit = Invoke-MigrationUnit @(New-MigrationDockerRules ($LineMigre + "`n") 0 '' 8000) -TimeoutSec 2
    Assert-Test 'migration : delai depasse -> erreur delai, sans attendre le conteneur' ($null -ne $unit.Value -and $unit.Value.Etat -ceq 'erreur' -and $unit.Value.Raison -ceq 'delai' -and $unit.Seconds -lt 7) ((Get-MigrationFields $unit.Value) + (' {0:N1} s' -f $unit.Seconds))
    Assert-Test 'migration : delai depasse -> docker rm -f joue avant de rendre la main' (@($unit.Calls | Where-Object { $_ -cmatch ('^rm -f ' + $MigrationNamePattern + '$') }).Count -eq 1) ($unit.Calls -join ' | ')

    foreach ($image in @('-evil', '--pull=always', 'image avec espace', '', ('a' * 260), 'img;calc')) {
        $unit = Invoke-MigrationUnit @(New-MigrationDockerRules ($LineMigre + "`n")) -Image $image
        Assert-Test ('migration : image refusee ({0}) -> erreur, aucun appel docker' -f $image.Substring(0, [Math]::Min(20, $image.Length))) ($null -eq $unit.Threw -and $null -ne $unit.Value -and $unit.Value.Etat -ceq 'erreur' -and $unit.Calls.Count -eq 0) ((Get-MigrationFields $unit.Value) + ' ' + ($unit.Calls -join ' | '))
    }
    $unit = Invoke-MigrationUnit @(New-MigrationDockerRules ($LineMigre + "`n")) -Project 'Opencode Cockpit'
    Assert-Test 'migration : nom de projet hors format -> erreur, aucun appel docker' ($null -ne $unit.Value -and $unit.Value.Etat -ceq 'erreur' -and $unit.Calls.Count -eq 0) (Get-MigrationFields $unit.Value)
    $unit = Invoke-MigrationUnit @(New-MigrationDockerRules ($LineMigre + "`n")) -Contexte 'autre'
    Assert-Test 'migration : contexte inconnu -> erreur, aucun appel docker' ($null -ne $unit.Value -and $unit.Value.Etat -ceq 'erreur' -and $unit.Calls.Count -eq 0) (Get-MigrationFields $unit.Value)
    # Docker introuvable : Get-Command leve dans Invoke-CockpitDocker ; la migration ne leve jamais.
    Set-Env 'PATH' (Join-Path $env:SystemRoot 'System32')
    try { $unit = Invoke-MigrationUnit @(New-MigrationDockerRules ($LineMigre + "`n")) } finally { Set-Env 'PATH' ((Join-Path $Here 'fake-docker') + ';' + $SavedEnv['PATH']) }
    Assert-Test 'migration : docker introuvable -> erreur docker, aucune exception' ($null -eq $unit.Threw -and $null -ne $unit.Value -and $unit.Value.Etat -ceq 'erreur' -and $unit.Value.Raison -ceq 'docker') ((Get-MigrationFields $unit.Value) + ' ' + [string]$unit.Threw)

    # Textes de l'installateur (fiche MW 7), ASCII ; rien pour absent ni pour conforme sans reste.
    $H = "==> Passage a la 1.1.0 : l'assistant ne va plus sur Internet"
    $HRestore = '==> Regles Internet de la sauvegarde restauree'
    $Deja = "    C'etait deja impossible depuis la 1.0.6 (seul GitHub Copilot est joignable), et une demande restee sans reponse pouvait bloquer les autres autorisations."
    $Copie = "    Copie de l'ancien fichier : {0}.avant-1.1.0, dans le volume de configuration d'opencode (compris dans .\cockpit.ps1 backup)."
    $Restes = "    [!] Certaines regles demandent encore l'acces a Internet : voir Parametres > Securite."
    $Laissees = '    [!] Regles Internet laissees telles quelles ({0}).'
    $ConseilProfil = "    Reglage conseille : Parametres > Securite > Fermer l'acces a Internet (votre profil est garde)."
    $ConseilPerso = "    Si l'assistant reste bloque sur une demande d'acces a Internet, refusez-la. En mode Avance : Parametres > opencode, mettez webfetch et websearch a deny."
    $NoStartFait = '    Le fichier est a jour ; il sera lu au prochain demarrage (.\cockpit.ps1 start).'
    $NoStartActif = '    [!] Regles Internet non mises a jour : opencode est en marche. Relancez .\install.ps1 sans -NoStart ; en attendant : Parametres > Securite.'
    function New-MigrationValue([string]$Etat, [string]$Profil = '-', [string]$Fichier = '-', [int]$Blocs = 0, [int]$Restes = 0, [string]$Sauvegarde = '-', [string]$Raison = '-') {
        return [pscustomobject]@{ Etat = $Etat; Profil = $Profil; Fichier = $Fichier; Blocs = $Blocs; Restes = $Restes; Sauvegarde = $Sauvegarde; Raison = $Raison }
    }
    function Get-LinesText($Value, [string]$Contexte) {
        try { return (@(Get-CockpitWebMigrationLines $Value $Contexte) -join "`n") } catch { return ('EXCEPTION ' + $_.Exception.Message) }
    }
    $textCases = @(
        @{ Name = 'absent'; Value = (New-MigrationValue 'absent'); Contexte = 'install'; Lines = @() },
        @{ Name = 'conforme sans reste'; Value = (New-MigrationValue 'conforme' '-' 'opencode.jsonc'); Contexte = 'install'; Lines = @() },
        @{ Name = 'conforme sans reste (restore)'; Value = (New-MigrationValue 'conforme' '-' 'opencode.jsonc'); Contexte = 'restore'; Lines = @() },
        @{ Name = 'migre Prudent'; Value = (New-MigrationValue 'migre' 'prudent' 'opencode.jsonc' 1 0 'opencode.jsonc.avant-1.1.0'); Contexte = 'install'
            Lines = @($H, "    [OK] Profil de droits Prudent conserve : seul l'acces a Internet est desormais refuse.", $Deja, ($Copie -f 'opencode.jsonc')) },
        @{ Name = 'migre Equilibre, sauvegarde existante'; Value = (New-MigrationValue 'migre' 'equilibre' 'opencode.json' 1 0 'existante'); Contexte = 'install'
            Lines = @($H, "    [OK] Profil de droits Equilibre conserve : seul l'acces a Internet est desormais refuse.", $Deja, ($Copie -f 'opencode.json')) },
        @{ Name = 'migre Sans confirmation (restore)'; Value = (New-MigrationValue 'migre' 'autonome' 'opencode.jsonc' 1 0 'opencode.jsonc.avant-1.1.0'); Contexte = 'restore'
            Lines = @($HRestore, "    [OK] Profil de droits Sans confirmation conserve : seul l'acces a Internet est desormais refuse.", $Deja, ($Copie -f 'opencode.jsonc')) },
        @{ Name = 'migre personnalise avec reste (-NoStart)'; Value = (New-MigrationValue 'migre' '-' 'config.json' 2 1 'config.json.avant-1.1.0'); Contexte = 'nostart'
            Lines = @($H, '    [OK] Vos regles personnalisees sont conservees : seules les regles Internet "sur demande" sont desormais refusees.', $Deja, ($Copie -f 'config.json'), $Restes, $NoStartFait) },
        @{ Name = 'conforme avec restes'; Value = (New-MigrationValue 'conforme' '-' 'opencode.jsonc' 0 2); Contexte = 'install'; Lines = @($H, $Restes) },
        @{ Name = 'opencode actif (-NoStart)'; Value = (New-MigrationValue 'non-migre' '-' '-' 0 0 '-' 'opencode-actif'); Contexte = 'nostart'; Lines = @($H, $NoStartActif) },
        @{ Name = 'opencode actif (install)'; Value = (New-MigrationValue 'non-migre' '-' '-' 0 0 '-' 'opencode-actif'); Contexte = 'install'; Lines = @($H, ($Laissees -f "opencode n'a pas pu etre arrete"), $ConseilPerso) },
        @{ Name = 'erreur, profil reconnu'; Value = (New-MigrationValue 'erreur' 'prudent' 'opencode.jsonc' 0 0 '-' 'verification'); Contexte = 'install'; Lines = @($H, ($Laissees -f 'verification impossible'), $ConseilProfil) },
        @{ Name = 'erreur delai'; Value = (New-MigrationValue 'erreur' '-' '-' 0 0 '-' 'delai'); Contexte = 'restore'; Lines = @($HRestore, ($Laissees -f 'verification impossible'), $ConseilPerso) })
    $reasons = [ordered]@{ 'plusieurs-fichiers' = 'plusieurs fichiers de configuration'; 'illisible' = 'fichier de configuration illisible'; 'cle-en-double' = 'regle ecrite deux fois'
        'inhabituel' = 'fichier de configuration inhabituel'; 'lien-ou-special' = 'fichier de configuration remplace par un lien ou un element special'; 'trop-gros' = 'fichier de configuration trop gros'
        'modifie-pendant' = 'fichier modifie pendant la mise a jour'; 'sauvegarde-impossible' = 'copie de securite impossible' }
    foreach ($reason in @($reasons.Keys)) {
        $textCases += @{ Name = ('non-migre ' + $reason); Value = (New-MigrationValue 'non-migre' '-' 'opencode.jsonc' 0 0 '-' $reason); Contexte = 'install'; Lines = @($H, ($Laissees -f $reasons[$reason]), $ConseilPerso) }
    }
    $textCases += @{ Name = 'non-migre, profil reconnu'; Value = (New-MigrationValue 'non-migre' 'equilibre' 'opencode.jsonc' 0 0 '-' 'modifie-pendant'); Contexte = 'install'; Lines = @($H, ($Laissees -f 'fichier modifie pendant la mise a jour'), $ConseilProfil) }
    foreach ($case in $textCases) {
        $got = Get-LinesText $case.Value $case.Contexte
        Assert-Test ('migration, textes : {0}' -f $case.Name) ($got -ceq ($case.Lines -join "`n")) $got
        Assert-Test ('migration, textes ASCII : {0}' -f $case.Name) ($got -cmatch '^[\x20-\x7E\n]*\z') $got
    }

    # --- install.ps1 : ordre de l'etape 4, textes, jamais bloquante ---------------------------------------------------------------
    Write-Section 'Migration du web (A37) : etape 4 d install.ps1, -NoStart'
    $migEnv = New-BaseEnv $Ports.A 'https' '' (New-CockpitChallenge) $Version
    function Invoke-MigrationInstall([string]$Name, [hashtable]$RuleParams, [hashtable]$Extra = @{}) {
        Reset-Root $migEnv
        $ruleArgs = @{ CertFile = $CertFile; JsonFile = $JsonFile }
        foreach ($key in @($RuleParams.Keys)) { $ruleArgs[$key] = $RuleParams[$key] }
        $journal = Set-InstallDockerScenario $Work ('migration-install-' + $Name) (New-InstallDockerRules @ruleArgs)
        $params = @{ NoBrowser = $true }
        foreach ($key in @($Extra.Keys)) { $params[$key] = $Extra[$key] }
        $result = Invoke-Install -Root $Root -Parameters (New-Params $params) -Policies (Get-PolicySet 'Autorise' $Ports.A)
        return [pscustomobject]@{ Result = $result; Calls = @(Get-DockerCalls $journal | ForEach-Object { (@($_.args) -join ' ') }) }
    }
    function Get-CallIndex([string[]]$Calls, [string]$Pattern) {
        for ($i = 0; $i -lt $Calls.Count; $i++) { if ($Calls[$i] -cmatch $Pattern) { return $i } }
        return -1
    }

    $run = Invoke-MigrationInstall 'ordre' @{}
    $order = @((Get-CallIndex $run.Calls '^compose -f \S+ up --no-start --remove-orphans\z'),
        (Get-CallIndex $run.Calls '^run --rm --pull never --network none --user 0 --entrypoint chown -v opencode-cockpit_oc-config'),
        (Get-CallIndex $run.Calls '^compose -f \S+ stop opencode\z'),
        (Get-CallIndex $run.Calls '^compose -f \S+ ps -q --status running opencode\z'),
        (Get-CallIndex $run.Calls $ExactRun),
        (Get-CallIndex $run.Calls '^compose -f \S+ up -d --remove-orphans\z'))
    $ordered = @($order | Where-Object { $_ -lt 0 }).Count -eq 0
    for ($i = 1; $i -lt $order.Count; $i++) { if ($order[$i] -le $order[$i - 1]) { $ordered = $false } }
    Assert-Test 'etape 4 : up --no-start, chown, stop opencode, controle, migration, up -d, dans cet ordre' $ordered (($order -join ',') + ' : ' + ($run.Calls -join ' | '))
    Assert-Test 'etape 4 : volume neuf (absent) -> rien d affiche, installation terminee' ($null -eq $run.Result.Error -and -not $run.Result.Host.Contains('Passage a la 1.1.0') -and $run.Result.Host.Contains('Cockpit disponible sur')) $run.Result.Host

    $run = Invoke-MigrationInstall 'migre' @{ Migration = $LineMigre }
    $expected = @($H, "    [OK] Profil de droits Prudent conserve : seul l'acces a Internet est desormais refuse.", $Deja, ($Copie -f 'opencode.jsonc')) -join "`n"
    Assert-Test 'etape 4 : Prudent 1.0 migre -> textes exacts, installation terminee' ($null -eq $run.Result.Error -and $run.Result.Host.Contains($expected) -and $run.Result.Host.Contains('Cockpit disponible sur')) $run.Result.Host

    $run = Invoke-MigrationInstall 'restes' @{ Migration = 'migration-web etat=conforme profil=- fichier=opencode.jsonc blocs=0 restes=2 sauvegarde=- raison=-' }
    Assert-Test 'etape 4 : conforme avec restes -> en-tete et ligne [!] seulement' ($run.Result.Host.Contains(($H, $Restes) -join "`n") -and -not $run.Result.Host.Contains('[OK] Profil de droits')) $run.Result.Host

    $run = Invoke-MigrationInstall 'inattendue' @{ Migration = 'sortie sans rapport' }
    $rmAt = Get-CallIndex $run.Calls ('^rm -f ' + $MigrationNamePattern + '$')
    $upAt = Get-CallIndex $run.Calls '^compose -f \S+ up -d --remove-orphans\z'
    Assert-Test 'etape 4 : sortie inattendue -> [!] verification impossible, installation terminee' ($null -eq $run.Result.Error -and $run.Result.Host.Contains((($H, ($Laissees -f 'verification impossible'), $ConseilPerso) -join "`n")) -and $run.Result.Host.Contains('Cockpit disponible sur')) $run.Result.Host
    Assert-Test 'etape 4 : sortie inattendue -> docker rm -f AVANT up -d' ($rmAt -ge 0 -and $upAt -gt $rmAt) ($run.Calls -join ' | ')

    foreach ($case in @(@{ Name = 'stop-echec'; Params = @{ StopFails = $true } }, @{ Name = 'toujours-en-marche'; Params = @{ OpencodeRunning = $true } })) {
        $run = Invoke-MigrationInstall $case.Name $case.Params
        Assert-Test ('etape 4 ({0}) : aucune migration' -f $case.Name) ((Get-CallIndex $run.Calls ('^run --rm --pull never --name ' + $MigrationNamePattern)) -lt 0) ($run.Calls -join ' | ')
        Assert-Test ('etape 4 ({0}) : [!] opencode non arrete, up -d joue, installation terminee' -f $case.Name) ($null -eq $run.Result.Error -and $run.Result.Host.Contains(($Laissees -f "opencode n'a pas pu etre arrete")) -and (Get-CallIndex $run.Calls '^compose -f \S+ up -d --remove-orphans\z') -ge 0 -and $run.Result.Host.Contains('Cockpit disponible sur')) $run.Result.Host
    }

    # -NoStart : migration seulement si le volume existe ET si opencode ne tourne pas ; jamais de demarrage.
    $run = Invoke-MigrationInstall 'nostart-sans-volume' @{} @{ NoStart = $true }
    Assert-Test '-NoStart, volume absent : aucun run de migration, rien d affiche' ((Get-CallIndex $run.Calls ('^run --rm --pull never --name ' + $MigrationNamePattern)) -lt 0 -and -not $run.Result.Host.Contains('Passage a la 1.1.0') -and (Get-CallIndex $run.Calls '^volume inspect ') -ge 0) ($run.Calls -join ' | ')
    $run = Invoke-MigrationInstall 'nostart-en-marche' @{ VolumeExists = $true; OpencodeRunning = $true; Migration = $LineMigre } @{ NoStart = $true }
    Assert-Test '-NoStart, opencode en marche : aucun run, ligne [!] propre a -NoStart' ((Get-CallIndex $run.Calls ('^run --rm --pull never --name ' + $MigrationNamePattern)) -lt 0 -and $run.Result.Host.Contains((($H, $NoStartActif) -join "`n"))) ($run.Result.Host + ' || ' + ($run.Calls -join ' | '))
    Assert-Test '-NoStart, opencode en marche : aucun arret demande' ((Get-CallIndex $run.Calls '^compose -f \S+ stop') -lt 0) ($run.Calls -join ' | ')
    $run = Invoke-MigrationInstall 'nostart-arrete' @{ VolumeExists = $true; Migration = $LineMigre } @{ NoStart = $true }
    Assert-Test '-NoStart, volume present et pile arretee : migration, textes, aucun up' ((Get-CallIndex $run.Calls $ExactRun) -ge 0 -and (Get-CallIndex $run.Calls ' up ') -lt 0 -and $run.Result.Host.Contains((($H, "    [OK] Profil de droits Prudent conserve : seul l'acces a Internet est desormais refuse.", $Deja, ($Copie -f 'opencode.jsonc'), $NoStartFait) -join "`n"))) ($run.Result.Host + ' || ' + ($run.Calls -join ' | '))
    Assert-Test '-NoStart, volume present et pile arretee : aucun arret demande' ((Get-CallIndex $run.Calls '^compose -f \S+ stop') -lt 0) ($run.Calls -join ' | ')
} finally {
    foreach ($server in $Servers) {
        try { $server.StandardInput.Close(); [void]$server.WaitForExit(5000) } catch { }
        try { if (-not $server.HasExited) { $server.Kill() } } catch { }
        try { $server.Dispose() } catch { }
    }
    foreach ($name in $EnvNames) { [Environment]::SetEnvironmentVariable($name, $SavedEnv[$name], 'Process') }
    [Environment]::SetEnvironmentVariable('COCKPIT_TEST_DOCKER_SCENARIO', $null, 'Process')
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host ('Total : {0} verifications, {1} en echec' -f ($Results.Pass + $Results.Fail), $Results.Fail) -ForegroundColor White
if ($Results.Fail -gt 0) {
    foreach ($failure in $Results.Failures) { Write-Host ('    - ' + $failure) -ForegroundColor Red }
    exit 1
}
exit 0
