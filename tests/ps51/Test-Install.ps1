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
    Assert-Test 'neuve HTTPS : volume cockpit-tls prepare avec l image app, sans -R' (@($joined | Where-Object { $_ -cmatch '^run --rm --network none --user 0 --entrypoint chown -v opencode-cockpit_cockpit-tls:/tls opencode-cockpit/app:local 1000:1000 /tls\z' }).Count -eq 1) ($joined -join ' | ')
    Assert-Test 'neuve HTTPS : droits 0700 du volume cockpit-tls' (@($joined | Where-Object { $_ -cmatch '^run --rm --network none --user 0 --entrypoint chmod -v opencode-cockpit_cockpit-tls:/tls opencode-cockpit/app:local 0700 /tls\z' }).Count -eq 1)
    Assert-Test 'neuve HTTPS : volumes partages sans reseau' (@($joined | Where-Object { $_ -cmatch '^run --rm --network none --user 0 --entrypoint chown -v opencode-cockpit_oc-config' }).Count -eq 1)
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
