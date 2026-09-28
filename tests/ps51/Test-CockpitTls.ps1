# Test-CockpitTls.ps1 - tests de CockpitTls.ps1 sous Windows PowerShell 5.1 (plan v2, lot 5). Sans Pester.
# Usage : powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/ps51/Test-CockpitTls.ps1 [-FailFast]
# Banc : certificats .NET (New-TestCerts.ps1), srv-test.mjs (Node 24), faux docker et faux curl, espions (Spies.ps1).
# Aucun secret reel : jeton aleatoire propre a l'execution, jamais affiche. Registre : seulement HKCU:\Software\opencode-cockpit-test.
# -FailFast : arret au premier echec (nettoyage compris), pour les campagnes de mutations.
param([switch]$FailFast)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $Here '..\..'))
. (Join-Path $RepoRoot 'CockpitTls.ps1')
. (Join-Path $Here 'ComposeConfig.ps1')

$Results = @{ Pass = 0; Fail = 0; Failures = (New-Object System.Collections.Generic.List[string]) }
function Assert-Test([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) { $Results.Pass++; return }
    $Results.Fail++
    $Results.Failures.Add(($Name + ' ' + $Detail).Trim())
    Write-Host ('  [KO] {0} {1}' -f $Name, $Detail) -ForegroundColor Red
    if ($FailFast) { throw ('FailFast : ' + $Name) }
}
function Write-Section([string]$Title) { Write-Host ('--- ' + $Title) -ForegroundColor Cyan }

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

# Espions charges dans la portee d'une fonction : ils disparaissent a sa sortie.
function Invoke-WithSpies([scriptblock]$Setup, [scriptblock]$Block) {
    . (Join-Path $Here 'Spies.ps1')
    & $Setup
    & $Block
}

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ('cockpit-ps51-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Work | Out-Null
$EnvNames = @('PATH', 'COCKPIT_TEST_DOCKER_SCENARIO', 'COCKPIT_TEST_CURL_LOG', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'CURL_HOME', 'HOME', 'APPDATA',
    'COCKPIT_LOCAL_SCHEME', 'COCKPIT_LOCAL_HTTP_CONFIRMED', 'COCKPIT_TOKEN', 'WORKSPACE_DIR', 'cockpit_port', 'COMPOSE_PROFILES')
$SavedEnv = @{}
foreach ($name in $EnvNames) { $SavedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$Servers = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$TestRegistryRoot = 'HKCU:\Software\opencode-cockpit-test'
$Node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$RealCurl = Join-Path ([Environment]::GetFolderPath('System')) 'curl.exe'
$FakeCurl = Join-Path $Here 'fake-curl'
$DockerState = @{ Index = 0; Journal = '' }

function Set-Env([string]$Name, [string]$Value) { [Environment]::SetEnvironmentVariable($Name, $Value, 'Process') }
# Assemblages sans emplacement : ceux qu'Add-Type compile en memoire.
function Get-DynamicAssemblyCount { return @([AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.IsDynamic -or [string]::IsNullOrEmpty($_.Location) }).Count }

function Start-TestServer([hashtable]$Config, [hashtable]$Environment) {
    $file = Join-Path $Work ('srv-' + [guid]::NewGuid().ToString('N') + '.json')
    [System.IO.File]::WriteAllText($file, (ConvertTo-Json -Depth 6 $Config))
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo -Property @{ FileName = $Node; Arguments = ('"{0}" "{1}"' -f (Join-Path $Here 'srv-test.mjs'), $file)
        UseShellExecute = $false; RedirectStandardInput = $true; RedirectStandardOutput = $true; RedirectStandardError = $true; CreateNoWindow = $true }
    foreach ($key in @($Environment.Keys)) { $startInfo.EnvironmentVariables[$key] = $Environment[$key] }
    $process = [System.Diagnostics.Process]::Start($startInfo)
    $Servers.Add($process)
    $line = $process.StandardOutput.ReadLine()
    if (-not $line) { throw ('srv-test.mjs ne demarre pas : ' + $process.StandardError.ReadToEnd()) }
    return (ConvertFrom-Json $line).ports
}

# Scenario du faux docker : regles ordonnees (voir fake-docker.ps1) ; chaque appel en cree un nouveau fichier.
function Set-DockerScenario([object[]]$Rules) {
    $DockerState.Index++
    $file = Join-Path $Work ('docker-{0}.json' -f $DockerState.Index)
    [System.IO.File]::WriteAllText($file, (ConvertTo-Json -Depth 6 @{ rules = @($Rules) }))
    Set-Env 'COCKPIT_TEST_DOCKER_SCENARIO' $file
    $DockerState.Journal = $file + '.jsonl'
}
function Get-DockerJournal {
    if (-not (Test-Path -LiteralPath $DockerState.Journal)) { return @() }
    return @(Get-Content -LiteralPath $DockerState.Journal | Where-Object { $_ } | ForEach-Object { ConvertFrom-Json $_ })
}
function New-Rule([string]$Match, [string]$Stdout = '', [int]$Code = 0, $Uses = $null, [string]$StdoutFile = '') {
    $rule = [ordered]@{ match = $Match; stdout = $Stdout; code = $Code }
    if ($null -ne $Uses) { $rule['uses'] = $Uses }
    if ($StdoutFile) { $rule['stdoutFile'] = $StdoutFile }
    return $rule
}

try {
    # --- Banc ---------------------------------------------------------------------------------------------------------
    Write-Section 'Banc : certificats, serveurs, faux docker'
    $certDir = Join-Path $Work 'certs'
    $Certs = @{}
    foreach ($cert in @(& (Join-Path $Here 'New-TestCerts.ps1') -Directory $certDir)) { $Certs[$cert.Name] = $cert }
    Assert-Test 'banc : quatre certificats de test' ($Certs.Count -eq 4)
    Assert-Test 'banc : aucune cle CNG persistante creee' (-not [System.Security.Cryptography.CngKey]::Exists(''))
    $Token = New-CockpitChallenge
    $BehaviorFile = Join-Path $Work 'behavior.json'
    $ServerLog = Join-Path $Work 'srv-test.jsonl'
    $Ports = Start-TestServer @{ certDir = $certDir; behaviorFile = $BehaviorFile; logFile = $ServerLog; listeners = @(
            @{ name = 'A'; kind = 'https'; cert = 'A' }, @{ name = 'B'; kind = 'https'; cert = 'B' }, @{ name = 'A12'; kind = 'https'; cert = 'A'; maxVersion = 'TLSv1.2' },
            @{ name = 'expire'; kind = 'https'; cert = 'expire' }, @{ name = 'dns'; kind = 'https'; cert = 'dns' }, @{ name = 'close'; kind = 'close' }, @{ name = 'plain'; kind = 'http' },
            @{ name = 'hang'; kind = 'hang' }) } @{ SRV_TEST_TOKEN = $Token }
    $probe = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
    $probe.Start()
    $ClosedPort = $probe.LocalEndpoint.Port
    $probe.Stop()
    Assert-Test 'banc : aucun port 7777' (@($Ports.PSObject.Properties | Where-Object { $_.Value -eq 7777 }).Count -eq 0 -and $ClosedPort -ne 7777)
    $tlsProbe = 'const tls = require("tls"); const s = tls.connect({ host: "127.0.0.1", port: Number(process.argv[1]), minVersion: "TLSv1.3", rejectUnauthorized: false }, () => { process.stdout.write(s.getProtocol()); s.destroy(); }); s.on("error", () => process.stdout.write("refus"));'
    $probeA = (Invoke-CockpitProcess -FilePath $Node -Arguments @('-e', $tlsProbe, [string]$Ports.A) -TimeoutSec 20).StdOut
    $probeA12 = (Invoke-CockpitProcess -FilePath $Node -Arguments @('-e', $tlsProbe, [string]$Ports.A12) -TimeoutSec 20).StdOut
    Assert-Test 'banc : ecouteur A12 limite a TLS 1.2 (TLS 1.3 accepte par A, refuse par A12)' ($probeA -ceq 'TLSv1.3' -and $probeA12 -ceq 'refus') ('A={0} A12={1}' -f $probeA, $probeA12)
    Assert-Test 'processus a l ecoute : nom lu, inconnu sur un port ferme' ((Get-CockpitPortOwner $Ports.A) -ceq 'node' -and (Get-CockpitPortOwner $ClosedPort) -ceq 'inconnu') (Get-CockpitPortOwner $Ports.A)
    # Comportement relu a chaque requete : ecouteur HTTP "plain", et ecouteur HTTPS "A" en second parametre.
    function Set-Behavior([hashtable]$Plain, [hashtable]$HttpsA = @{}) { [System.IO.File]::WriteAllText($BehaviorFile, (ConvertTo-Json -Depth 4 @{ plain = $Plain; A = $HttpsA })) }
    Set-Behavior @{}
    $StateA = ConvertTo-CockpitTlsState $Certs['A'].PemText $Certs['A'].JsonText
    $StateB = ConvertTo-CockpitTlsState $Certs['B'].PemText $Certs['B'].JsonText
    $StateExpire = ConvertTo-CockpitTlsState $Certs['expire'].PemText $Certs['expire'].JsonText
    $StateDns = ConvertTo-CockpitTlsState $Certs['dns'].PemText $Certs['dns'].JsonText
    Set-Env 'PATH' ((Join-Path $Here 'fake-docker') + ';' + $SavedEnv['PATH'])

    # --- Vecteurs communs et fonctions pures (K1-5) ------------------------------------------------------------------
    Write-Section 'Vecteurs communs, jeton, adresse, defi'
    $vectors = Get-Content -LiteralPath (Join-Path $RepoRoot 'tests\vectors\local-access.json') -Raw | ConvertFrom-Json
    foreach ($case in @($vectors.localAccess)) {
        $config = [ordered]@{}
        if ($null -ne $case.scheme) { $config['COCKPIT_LOCAL_SCHEME'] = $case.scheme }
        if ($null -ne $case.confirmedAt) { $config['COCKPIT_LOCAL_HTTP_CONFIRMED'] = $case.confirmedAt }
        $mode = Get-CockpitLocalMode $config
        Assert-Test ('K1-5 localAccess : ' + $case.name) ($mode.Valid -eq [bool]$case.valid -and $mode.Scheme -ceq $case.localScheme) ('valid={0} scheme={1}' -f $mode.Valid, $mode.Scheme)
    }
    foreach ($at in @($vectors.dates.accepted)) { Assert-Test ('K1-5 date acceptee : ' + $at) (Test-CockpitConfirmedAt $at) }
    foreach ($at in @($vectors.dates.rejected)) { Assert-Test ('K1-5 date refusee : ' + $at) (-not (Test-CockpitConfirmedAt $at)) }
    foreach ($trap in @(([string][char]0x0662 + '026-09-15T10:32:00Z'), ('2026-09-15T10:32:00Z' + [char]10 + 'x'))) { Assert-Test 'K1-5 chiffre Unicode ou texte apres saut de ligne refuse' (-not (Test-CockpitConfirmedAt $trap)) }
    $marked = Get-CockpitLocalMode ([ordered]@{ COCKPIT_LOCAL_SCHEME = 'MARQUEUR-VALEUR-L5' })
    Assert-Test 'mode lu : Problem sans la valeur lue' (-not $marked.Valid -and $marked.Problem -ceq 'valeur non reconnue' -and -not ([string]$marked.Problem).Contains('MARQUEUR'))
    $httpNoDate = Get-CockpitLocalMode ([ordered]@{ COCKPIT_LOCAL_SCHEME = 'http' })
    Assert-Test 'mode lu : http sans date nomme la cle' ($httpNoDate.Problem -ceq 'COCKPIT_LOCAL_SCHEME=http sans date de confirmation valable')
    Assert-Test 'mode lu : aucune exception sur une entree inattendue' (-not (Get-CockpitLocalMode 42).Valid)
    Assert-Test 'mode lu : .env vide = https' ((Get-CockpitLocalMode ([ordered]@{})).Scheme -ceq 'https')
    Assert-Test 'HMAC health-proof = vecteur' ((Get-CockpitHmacHex $vectors.hmac.token 'health-proof' $vectors.hmac.healthProof.challenge) -ceq $vectors.hmac.healthProof.expected)
    Assert-Test 'HMAC auth-ticket-request = vecteur' ((Get-CockpitHmacHex $vectors.hmac.token 'auth-ticket-request' $vectors.hmac.authTicketRequest.challenge) -ceq $vectors.hmac.authTicketRequest.expected)
    Assert-Test 'HMAC auth-ticket = vecteur' ((Get-CockpitHmacHex $vectors.hmac.token 'auth-ticket' $vectors.hmac.authTicket.nonce) -ceq $vectors.hmac.authTicket.expected)
    $signedQuery = 'challenge=' + ('b' * 64) + '&ticket=' + (Get-CockpitHmacHex $Token 'auth-ticket-request' ('b' * 64))
    Assert-Test 'requete de sante : demande de ticket signee (64 hex) acceptee' ($null -eq (Invoke-Captured { Assert-CockpitHealthQuery $signedQuery }).Error)
    foreach ($query in @(('challenge=' + ('b' * 64) + '&ticket=1'), ('challenge=' + ('b' * 64) + '&ticket=' + ('B' * 64)), ('challenge=' + ('b' * 64) + '&ticket=' + $Token + '&x=1'))) {
        Assert-Test ('requete de sante : demande de ticket non signee refusee ({0})' -f $query.Length) ($null -ne (Invoke-Captured { Assert-CockpitHealthQuery $query }).Error)
    }
    Assert-Test 'HMAC : usage inconnu refuse' ($null -ne (Invoke-Captured { Get-CockpitHmacHex 'x' 'session' 'y' }).Error)
    Assert-Test 'jeton genere : 64 hex minuscules' ((Test-CockpitGeneratedToken ('a' * 64)) -and -not (Test-CockpitGeneratedToken ('A' * 64)) -and -not (Test-CockpitGeneratedToken ('a' * 40)) -and -not (Test-CockpitGeneratedToken (('a' * 64) + [char]10)))
    Assert-Test 'adresse de base https' ((Get-CockpitBaseUrl 'https' 7777) -ceq ('https' + '://127.0.0.1:7777'))
    Assert-Test 'adresse de base : schema en majuscules refuse' ($null -ne (Invoke-Captured { Get-CockpitBaseUrl 'HTTPS' 7777 }).Error)
    Assert-Test 'adresse de base : port 0 refuse' ($null -ne (Invoke-Captured { Get-CockpitBaseUrl 'http' 0 }).Error)
    $challenges = @(1..3 | ForEach-Object { New-CockpitChallenge })
    Assert-Test 'defi : 64 hex minuscules, jamais repete' (@($challenges | Where-Object { $_ -cmatch '^[0-9a-f]{64}\z' }).Count -eq 3 -and @($challenges | Sort-Object -Unique).Count -eq 3)

    # --- Invoke-CockpitProcess (P5) ----------------------------------------------------------------------------------
    Write-Section 'Invoke-CockpitProcess'
    $run = Invoke-Captured { Invoke-CockpitProcess -FilePath $Node -Arguments @('-e', "console.error('ligne sur stderr'); process.exit(3)") -TimeoutSec 20 }
    Assert-Test 'P5 : stderr sous ErrorActionPreference Stop ne leve rien' ($null -eq $run.Error -and $run.Values[0].ExitCode -eq 3 -and $run.Values[0].StdErr.Contains('ligne sur stderr'))
    $killMarker = Join-Path $Work 'processus-non-arrete.txt'
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $slow = Invoke-CockpitProcess -FilePath $Node -Arguments @('-e', 'setTimeout(() => require("fs").writeFileSync(process.argv[1], "x"), 2500)', $killMarker) -TimeoutSec 1
    $watch.Stop()
    Start-Sleep -Milliseconds 3500
    Assert-Test 'delai : rend la main au delai' ($slow.TimedOut -and $slow.ExitCode -eq -1 -and $watch.Elapsed.TotalSeconds -lt 5) ('{0:N1} s' -f $watch.Elapsed.TotalSeconds)
    Assert-Test 'delai : processus reellement arrete (rien ecrit apres le delai)' (-not (Test-Path -LiteralPath $killMarker))
    Set-Env 'COCKPIT_TOKEN' 'MARQUEUR-JETON-L5'
    $envRun = Invoke-CockpitProcess -FilePath $Node -Arguments @('-e', "process.stdout.write(process.env.COCKPIT_TOKEN === undefined ? 'absent' : 'present')") -TimeoutSec 20 -RemoveEnv @('cockpit_token')
    Assert-Test '-RemoveEnv : variable absente chez l enfant, toute casse' ($envRun.StdOut -ceq 'absent')
    Assert-Test '-RemoveEnv : processus PowerShell intact' ([Environment]::GetEnvironmentVariable('COCKPIT_TOKEN', 'Process') -ceq 'MARQUEUR-JETON-L5')
    Set-Env 'COCKPIT_TOKEN' $SavedEnv['COCKPIT_TOKEN']
    $samples = @('@{u}', '@{u}..HEAD', '', 'a b', 'x\', 'q"q', 'x\"y', 'C:\dossier avec espace\', '\\srv\partage\', '\n%{http_code}', 'challenge=aa&ticket=1', '{{range .Config.Env}}{{println .}}{{end}}')
    $argv = Invoke-CockpitProcess -FilePath $Node -Arguments (@('-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))') + $samples) -TimeoutSec 20
    $received = @()
    foreach ($item in (ConvertFrom-Json $argv.StdOut)) { $received += [string]$item }
    $same = $received.Count -eq $samples.Count
    for ($i = 0; $same -and $i -lt $samples.Count; $i++) { $same = $received[$i] -ceq $samples[$i] }
    Assert-Test "M-GITARGS : '@{u}', vide, espaces, guillemet, barre finale et & transmis intacts" $same
    Assert-Test 'chemin relatif refuse' ($null -ne (Invoke-Captured { Invoke-CockpitProcess -FilePath 'node.exe' -Arguments @('-v') }).Error)
    Assert-Test 'Hide-Secrets : jeton GitHub et mot de passe masques' ((Hide-Secrets ('ghp_' + ('A' * 30) + ' password=abc')) -ceq 'ghp_**** password=****')

    # --- Langage PowerShell (AppLocker / WDAC) ------------------------------------------------------------------------
    Write-Section 'Assert-CockpitFullLanguage'
    Assert-Test 'FullLanguage : aucune exception' ($null -eq (Invoke-Captured { Assert-CockpitFullLanguage }).Error)
    $PowerShellExe = (Get-Command powershell.exe -CommandType Application | Select-Object -First 1).Source
    $clmChild = Join-Path $Work 'clm-child.ps1'
    # Bascule en ConstrainedLanguage AVANT le chargement : les fonctions de la bibliotheque s'executent alors dans ce mode.
    [System.IO.File]::WriteAllText($clmChild, ("`$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'`r`n. '" + (Join-Path $RepoRoot 'CockpitTls.ps1') + "'`r`ntry { Assert-CockpitFullLanguage; 'AUCUNE EXCEPTION' } catch { 'REFUS : ' + `$_.Exception.Message }`r`n"), (New-Object System.Text.UTF8Encoding $true))
    $clm = Invoke-CockpitProcess -FilePath $PowerShellExe -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $clmChild) -TimeoutSec 60
    Assert-Test 'ConstrainedLanguage : arret explicite avant tout travail' ($clm.StdOut.Contains('REFUS : PowerShell est en mode de langage ConstrainedLanguage')) ($clm.StdOut + $clm.StdErr).Trim()

    # --- Isolation compose (K1-1) ------------------------------------------------------------------------------------
    Write-Section 'Isolation de docker compose'
    $composeNames = @([regex]::Matches([System.IO.File]::ReadAllText((Join-Path $RepoRoot 'docker-compose.yml')), '\$\{([A-Z_][A-Z0-9_]*)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    Assert-Test 'K1-1 : chaque variable de docker-compose.yml est masquee' (@($composeNames | Where-Object { $CockpitComposeEnvNames -cnotcontains $_ }).Count -eq 0 -and @('COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_PROFILES' | Where-Object { $CockpitComposeEnvNames -cnotcontains $_ }).Count -eq 0)
    Set-Env 'cockpit_port' '9999'
    Set-Env 'HTTP_PROXY' 'http://127.0.0.1:9'
    $saved = Clear-CockpitComposeEnv
    Assert-Test 'K1-1 : masquage en toute casse' ($null -eq [Environment]::GetEnvironmentVariable('COCKPIT_PORT', 'Process') -and $null -eq [Environment]::GetEnvironmentVariable('HTTP_PROXY', 'Process'))
    Assert-Test 'K1-1 : nom reel conserve' (@($saved.Keys) -ccontains 'cockpit_port')
    Restore-CockpitComposeEnv $saved
    Assert-Test 'K1-1 : restauration' ([Environment]::GetEnvironmentVariable('cockpit_port', 'Process') -ceq '9999')
    try { $saved = Clear-CockpitComposeEnv; try { throw 'panne simulee' } finally { Restore-CockpitComposeEnv $saved } } catch { }
    Assert-Test 'K1-1 : restauration apres exception' ([Environment]::GetEnvironmentVariable('cockpit_port', 'Process') -ceq '9999' -and [Environment]::GetEnvironmentVariable('HTTP_PROXY', 'Process') -ceq 'http://127.0.0.1:9')
    Set-Env 'cockpit_port' $null
    Set-Env 'HTTP_PROXY' $SavedEnv['HTTP_PROXY']
    $spaced = 'C:\dossier avec espace'
    Assert-Test 'K1-1 : -f insere apres compose' (((ConvertTo-CockpitDockerArgs $spaced @('compose', 'up', '-d')) -join '|') -ceq ('compose|-f|' + $spaced + '\docker-compose.yml|up|-d'))
    Assert-Test 'compose version intact' (((ConvertTo-CockpitDockerArgs $spaced @('compose', 'version', '--short')) -join '|') -ceq 'compose|version|--short')
    Assert-Test 'commande hors compose intacte' (((ConvertTo-CockpitDockerArgs $spaced @('image', 'inspect', 'x')) -join '|') -ceq 'image|inspect|x')
    Assert-Test 'compose sans dossier refuse' ($null -ne (Invoke-Captured { ConvertTo-CockpitDockerArgs '' @('compose', 'ps') }).Error)
    $divergenceDir = Join-Path $Work 'divergence'
    New-Item -ItemType Directory -Path $divergenceDir | Out-Null
    foreach ($f in @('docker-compose.override.yml', 'compose.yaml')) { [System.IO.File]::WriteAllText((Join-Path $divergenceDir $f), 'services: {}') }
    Set-Env 'COCKPIT_LOCAL_SCHEME' 'MARQUEUR-VALEUR-DIVERGENCE'
    $divergence = Get-CockpitComposeDivergence $divergenceDir @('Process')
    Assert-Test 'divergence : variable nommee avec sa portee' (@($divergence.Variables | Where-Object { $_.Name -ceq 'COCKPIT_LOCAL_SCHEME' -and $_.Scope -ceq 'Process' }).Count -eq 1)
    Assert-Test 'divergence : fichiers voisins' ((@($divergence.Files) -join ',') -ceq 'docker-compose.override.yml,compose.yaml')
    Assert-Test 'divergence : jamais la valeur (marqueur)' (-not (ConvertTo-Json -Depth 4 $divergence).Contains('MARQUEUR'))

    # --- Surcharge des projets prepares et profil de la salle (D-2b-28, MO-3) ----------------------------------------
    # Les chaines que le test P13 de la CI interdit dans les scripts qu'elle appelle sont assemblees, jamais ecrites.
    Write-Section 'Surcharge des projets prepares et profil de la salle'
    $ContratSalle = Join-Path $RepoRoot ('docker\opencode' + '-omo\contrat-salle.json')
    $Contrat = ConvertFrom-Json ([System.IO.File]::ReadAllText($ContratSalle))
    $hors = @(@($Contrat.variables.cockpit) | Where-Object { $CockpitComposeEnvNames -cnotcontains $_ })
    Assert-Test 'contrat : variables du cockpit toutes masquees' ($hors.Count -eq 0) ($hors -join ', ')
    $salleDir = Join-Path $Work 'salle'
    New-Item -ItemType Directory -Path $salleDir | Out-Null
    $composeBase = Join-Path $salleDir 'docker-compose.yml'
    $overlayFile = Join-Path $salleDir $CockpitOmoOverlay
    function Set-SalleEnv([string]$Text) { [System.IO.File]::WriteAllText((Join-Path $salleDir '.env'), $Text, (New-Object System.Text.UTF8Encoding $false)) }
    function Get-SalleArgs([string[]]$DockerArgs) { return ((ConvertTo-CockpitDockerArgs $salleDir $DockerArgs) -join '|') }

    Set-SalleEnv "COCKPIT_PORT=7788`n"
    Assert-Test 'surcharge absente, salle coupee : arguments inchanges' ((Get-SalleArgs @('compose', 'up', '-d')) -ceq ('compose|-f|' + $composeBase + '|up|-d'))
    [System.IO.File]::WriteAllText($overlayFile, "services: {}`n", (New-Object System.Text.UTF8Encoding $false))
    Assert-Test 'surcharge presente : ajoutee apres le fichier de base' ((Get-SalleArgs @('compose', 'up', '-d')) -ceq ('compose|-f|' + $composeBase + '|-f|' + $overlayFile + '|up|-d'))
    Set-SalleEnv ("COCKPIT_PORT=7788`n" + ('{0}=exemple/salle:essai' -f ('COCKPIT_OMO' + '_IMAGE')) + "`n")
    Assert-Test 'image installee mais salle coupee : aucun profil' ((Get-SalleArgs @('compose', 'up', '-d')) -cnotmatch 'profile')
    Set-SalleEnv "COCKPIT_OMO=off`n"
    Assert-Test 'COCKPIT_OMO=off : aucun profil' ((Get-SalleArgs @('compose', 'up', '-d')) -cnotmatch 'profile')
    Set-SalleEnv "COCKPIT_OMO=ON`n"
    Assert-Test 'COCKPIT_OMO=ON : aucun profil (valeur exacte attendue)' ((Get-SalleArgs @('compose', 'up', '-d')) -cnotmatch 'profile')
    Set-SalleEnv "COCKPIT_OMO=on`n"
    Assert-Test 'COCKPIT_OMO=on : profil ajoute apres les fichiers' ((Get-SalleArgs @('compose', 'up', '-d')) -ceq ('compose|-f|' + $composeBase + '|-f|' + $overlayFile + '|--profile|omo|up|-d'))
    foreach ($sous in @('stop', 'down')) {
        Assert-Test ('MO-3 : profil repete pour ' + $sous) ((Get-SalleArgs @('compose', $sous)) -ceq ('compose|-f|' + $composeBase + '|-f|' + $overlayFile + '|--profile|omo|' + $sous))
    }
    Assert-Test 'compose version : ni surcharge ni profil' ((Get-SalleArgs @('compose', 'version', '--short')) -ceq 'compose|version|--short')
    Assert-Test 'commande hors compose : ni surcharge ni profil' ((Get-SalleArgs @('image', 'inspect', 'x')) -ceq 'image|inspect|x')
    # Relecture 2ter-vague-3 : une source de la surcharge absente, changee de forme ou devenue lien retire le profil des seules
    # commandes qui creent ou demarrent un conteneur (Docker la recreerait en dossier vide sur le poste) ; stop et down le gardent.
    $sourceDir = Join-Path $Work 'salle-sources'
    New-Item -ItemType Directory -Path (Join-Path $sourceDir 'app\src') -Force | Out-Null
    $ligneSalle = { param([string]$Relatif, [string]$Forme) '      - { type: bind, source: "' + ($sourceDir -replace '\\', '/') + '/' + $Relatif + '", target: "/workspace/' + $Relatif + '", bind: { create_host_path: false } } # ' + $Forme }
    [System.IO.File]::WriteAllText($overlayFile, ("services:`n  " + ('opencode' + '-omo') + ":`n    volumes:`n" + (& $ligneSalle 'app/src' 'dossier') + "`n" + (& $ligneSalle 'app/README.md' 'fichier') + "`n"), (New-Object System.Text.UTF8Encoding $false))
    Assert-Test 'sources de la salle : l entree absente est nommee' ((@(Get-CockpitOmoSourceProblems $salleDir) -join ',') -ceq 'app/README.md') (@(Get-CockpitOmoSourceProblems $salleDir) -join ', ')
    foreach ($sous in @('up', 'create', 'start', 'restart', 'run')) { Assert-Test ('sources de la salle : aucun profil pour ' + $sous) ((Get-SalleArgs @('compose', $sous)) -cnotmatch 'profile') (Get-SalleArgs @('compose', $sous)) }
    foreach ($sous in @('stop', 'down')) { Assert-Test ('sources de la salle : profil garde pour ' + $sous) ((Get-SalleArgs @('compose', $sous)) -ceq ('compose|-f|' + $composeBase + '|-f|' + $overlayFile + '|--profile|omo|' + $sous)) }
    [System.IO.File]::WriteAllText((Join-Path $sourceDir 'app\README.md'), "lisez-moi`n")
    Assert-Test 'sources de la salle : toutes presentes, profil rendu a up' ((Get-SalleArgs @('compose', 'up', '-d')) -ceq ('compose|-f|' + $composeBase + '|-f|' + $overlayFile + '|--profile|omo|up|-d'))
    [System.IO.File]::Delete((Join-Path $sourceDir 'app\README.md')); New-Item -ItemType Directory -Path (Join-Path $sourceDir 'app\README.md') | Out-Null
    Assert-Test 'sources de la salle : un fichier devenu dossier est refuse' ((@(Get-CockpitOmoSourceProblems $salleDir) -join ',') -ceq 'app/README.md')
    [System.IO.File]::WriteAllText($overlayFile, "services: {}`n", (New-Object System.Text.UTF8Encoding $false))
    $divergenceSalle = Get-CockpitComposeDivergence $salleDir @('Process')
    Assert-Test 'divergence : la surcharge generee n est pas un fichier voisin inattendu' (@($divergenceSalle.Files).Count -eq 0) ((@($divergenceSalle.Files)) -join ', ')
    # MO-3 point 3 : COMPOSE_PROFILES et --profile ne se melangent jamais ; la variable ne suit pas l'appel.
    Set-Env 'COMPOSE_PROFILES' 'autre'
    Set-DockerScenario @((New-Rule '^compose -f \S.* ps$' "vide`n"))
    $appelSalle = Invoke-CockpitDocker $salleDir @('compose', 'ps') 30
    $journalSalle = @(Get-DockerJournal)
    Assert-Test 'MO-3 : COMPOSE_PROFILES retiree de l environnement de docker' ($appelSalle.ExitCode -eq 0 -and $journalSalle.Count -gt 0 -and @($journalSalle[$journalSalle.Count - 1].env) -cnotcontains 'COMPOSE_PROFILES')
    Assert-Test 'MO-3 : le profil passe bien par --profile' ((@($journalSalle[$journalSalle.Count - 1].args) -join ' ').Contains('--profile omo'))
    Set-Env 'COMPOSE_PROFILES' $SavedEnv['COMPOSE_PROFILES']

    # --- Fonctions docker avec le faux docker (M-FAKEDOCKER) ---------------------------------------------------------
    Write-Section 'Fonctions docker (faux docker)'
    Set-DockerScenario @((New-Rule '^compose -f \S.* config --format json$' (New-FakeComposeConfigJson 'rg105-l5')),
        (New-Rule '^image inspect --format \{\{range \.Config\.Env\}\}\{\{println \.\}\}\{\{end\}\} app:105$' "PATH=/usr/bin`nCOCKPIT_VERSION=1.0.5`n"),
        (New-Rule '^image inspect .* app:dev$' "COCKPIT_VERSION=dev`n"), (New-Rule '^image inspect .* absente$' '' 1),
        (New-Rule '^compose -f \S.* exec -T cockpit printenv COCKPIT_LOCAL_SCHEME$' "http`n" 0 1), (New-Rule '^compose -f \S.* exec -T cockpit printenv COCKPIT_LOCAL_SCHEME$' '' 1 1),
        (New-Rule '^compose -f \S.* exec -T cockpit printenv COCKPIT_LOCAL_SCHEME$' ("HTTP" + [char]27 + "[0m`n") 0 1), (New-Rule '^compose -f \S.* exec -T cockpit printenv COCKPIT_LOCAL_SCHEME$' "`n" 0 1),
        (New-Rule '^compose -f \S.* ps -q cockpit$' "0123456789abcdef`n"), (New-Rule '^inspect --format \{\{\.State\.Health\.Status\}\} 0123456789abcdef$' "healthy`n"))
    Assert-Test 'nom du projet lu dans compose config' ((Get-CockpitComposeProjectName $Work) -ceq 'rg105-l5')
    Assert-Test 'version d image 1.0.5' ((Get-CockpitImageVersion 'app:105') -eq [version]'1.0.5')
    Assert-Test 'version d image dev : illisible' ($null -eq (Get-CockpitImageVersion 'app:dev'))
    Assert-Test 'image absente : $null' ($null -eq (Get-CockpitImageVersion 'absente'))
    $callsBefore = @(Get-DockerJournal).Count
    Assert-Test 'image commencant par un tiret : refusee sans appel' ($null -eq (Get-CockpitImageVersion '--help') -and @(Get-DockerJournal).Count -eq $callsBefore)
    Assert-Test 'schema servi lu par printenv' ((Get-CockpitServedScheme $Work) -ceq 'http')
    Assert-Test 'schema servi illisible : $null' ($null -eq (Get-CockpitServedScheme $Work))
    Assert-Test 'schema servi hors liste : inconnu, jamais recopie' ((Get-CockpitServedScheme $Work) -ceq 'inconnu')
    Assert-Test 'schema servi vide : https (I3)' ((Get-CockpitServedScheme $Work) -ceq 'https')
    Assert-Test 'sante Docker du conteneur' ((Get-CockpitContainerHealth $Work) -ceq 'healthy')
    Set-Env 'COCKPIT_LOCAL_SCHEME' 'http'
    Set-Env 'WORKSPACE_DIR' 'C:\ailleurs'
    Set-DockerScenario @((New-Rule '.*' '{"name":"Nom Invalide"}'))
    Assert-Test 'nom de projet invalide refuse' ($null -ne (Invoke-Captured { Get-CockpitComposeProjectName $Work }).Error)

    # Repetition generale F2 : depuis la 1.0.6, la vraie sortie porte HTTP_PROXY ET http_proxy d'un meme service. PS 5.1 la
    # refusait (DuplicateKeysInJsonString) : backup et restore tombaient toujours, et le nom du projet retombait sur
    # opencode-cockpit, celui d'une AUTRE installation (chown -R, migration du web). Temoin : le banc rend bien cette forme.
    $temoin = 'lu'
    try { $null = ConvertFrom-Json (New-FakeComposeConfigJson 'rg105-l5') } catch { $temoin = [string]$_.FullyQualifiedErrorId }
    Assert-Test 'banc : la sortie type de compose config porte HTTP_PROXY et http_proxy (illisible telle quelle pour ConvertFrom-Json)' ($temoin -clike 'DuplicateKeysInJsonString*') $temoin
    Set-DockerScenario @((New-Rule '.*' (New-FakeComposeConfigJson 'projet-renomme' 'C:\archives\du banc')))
    $lue = $null
    try { $lue = Read-CockpitComposeConfig $Work } catch { $lue = $null }
    Assert-Test 'configuration lue malgre HTTP_PROXY et http_proxy : nom, montage /archives, six cles du relais gardees' ($null -ne $lue -and [string]$lue.name -ceq 'projet-renomme' -and
        [string]@($lue.services.cockpit.volumes)[0].source -ceq 'C:/archives/du banc' -and @($lue.services.opencode.environment.PSObject.Properties).Count -eq 6)
    Assert-Test 'projet renomme : son nom, jamais opencode-cockpit' ((Get-CockpitComposeProjectName $Work) -ceq 'projet-renomme')
    # Cles distinctes gardees distinctes ('^' double, majuscule en '^' + minuscule) ; valeurs jamais touchees, meme quand elles
    # contiennent le texte d'une cle entre guillemets echappes.
    Set-DockerScenario @((New-Rule '.*' '{"name":"cles","services":{"a":{"environment":{"A^B":"1","a^b":"2","a^^b":"3","A_B":"4","a_b":"5","v":"x \"HTTP_PROXY\": y","V":"z"}}}}'))
    $lue = $null
    try { $lue = Read-CockpitComposeConfig $Work } catch { $lue = $null }
    Assert-Test 'cles de casse differente : sept proprietes distinctes, valeur a guillemets echappes intacte' ($null -ne $lue -and @($lue.services.a.environment.PSObject.Properties).Count -eq 7 -and
        @($lue.services.a.environment.PSObject.Properties | Where-Object { [string]$_.Value -ceq 'x "HTTP_PROXY": y' }).Count -eq 1)
    # Ferme en cas de doute : exception, jamais un nom fixe (il designerait les volumes d'une autre installation).
    $doutes = @(@{ Name = 'compose config en echec'; Stdout = ''; Code = 1; Error = 'Lecture de la configuration impossible' },
        @{ Name = 'texte libre'; Stdout = 'pas du json'; Code = 0; Error = 'Configuration docker compose illisible' },
        @{ Name = 'cle echappee en collision de casse'; Stdout = '{"name":"x","\u0041B":"1","ab":"2"}'; Code = 0; Error = 'Configuration docker compose illisible' },
        @{ Name = 'tableau'; Stdout = '[{"name":"x"}]'; Code = 0; Error = 'Configuration docker compose illisible' },
        @{ Name = 'name absent'; Stdout = '{"services":{}}'; Code = 0; Error = 'Nom de projet docker compose inattendu' },
        @{ Name = 'name vide'; Stdout = (New-FakeComposeConfigJson ''); Code = 0; Error = 'Nom de projet docker compose inattendu' })
    foreach ($case in $doutes) {
        Set-DockerScenario @((New-Rule '.*' $case.Stdout $case.Code))
        $echec = Invoke-Captured { Get-CockpitComposeProjectName $Work }
        # Values est une List : .Count directement (sous PS 5.1, @() sur cette liste vide leve "Argument types do not match").
        Assert-Test ('{0} : exception, jamais le nom fixe opencode-cockpit' -f $case.Name) ($null -ne $echec.Error -and $echec.Error.Contains($case.Error) -and $echec.Values.Count -eq 0) ([string]$echec.Error)
    }
    $journal = @(Get-DockerJournal)
    Assert-Test 'K1-1 : variables du shell absentes chez docker' ($journal.Count -gt 0 -and @($journal | Where-Object { @($_.env).Count -gt 0 }).Count -eq 0)
    Assert-Test 'K1-1 : -f explicite dans l appel compose' (@($journal | Where-Object { $_.args[0] -ceq 'compose' -and $_.args[1] -cne '-f' }).Count -eq 0)

    # Contrat du faux docker pour les lots 6 et 7 (tests/ps51/README.md) : resolution, arguments, codes, usages, journal.
    Set-Env 'COCKPIT_TOKEN' 'MARQUEUR-VALEUR-BANC'
    Set-DockerScenario @((New-Rule '^code-trois$' 'sortie partielle' 3), (New-Rule '^une-fois$' 'premier' 0 1), (New-Rule '^une-fois$' 'suivant'),
        [ordered]@{ match = '^load '; fail = $true }, [ordered]@{ match = '^stderr$'; stderr = "erreur voulue`n"; code = 0 }, (New-Rule '^image inspect --format \{\{range \.Config\.Env\}\}\{\{println \.\}\}\{\{end\}\} img$' "COCKPIT_VERSION=1.0.5`n"),
        (New-Rule '^compose -f C:\\dossier avec espace\\docker-compose\.yml config --format json$' '{}'))
    Assert-Test 'banc : & docker trouve le faux docker.cmd en tete du PATH' ((Split-Path -Leaf @(Get-Command docker -CommandType Application)[0].Source) -ceq 'docker.cmd')
    $viaAmp = & docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' img
    $ampCode = $LASTEXITCODE
    $ampEntry = @(Get-DockerJournal)[-1]
    Assert-Test 'banc : & docker, format Go intact, code et sortie' ($ampCode -eq 0 -and [string]$viaAmp -ceq 'COCKPIT_VERSION=1.0.5' -and @($ampEntry.args).Count -eq 5)
    Assert-Test 'banc : journal par & docker = NOMS des variables, jamais les valeurs' (@($ampEntry.env) -ccontains 'COCKPIT_TOKEN' -and -not [System.IO.File]::ReadAllText($DockerState.Journal).Contains('MARQUEUR-VALEUR-BANC'))
    $r = Invoke-CockpitDocker 'C:\dossier avec espace' @('compose', 'config', '--format', 'json') 30
    Assert-Test 'banc : chemin a espaces intact par Invoke-CockpitDocker' ($r.ExitCode -eq 0 -and $r.StdOut -ceq '{}')
    $r = Invoke-CockpitDocker '' @('code-trois') 30
    Assert-Test 'banc : code de sortie et stdout propages' ($r.ExitCode -eq 3 -and $r.StdOut -ceq 'sortie partielle')
    $r = Invoke-CockpitDocker '' @('stderr') 30
    Assert-Test 'banc : stderr propage' ($r.ExitCode -eq 0 -and $r.StdErr -ceq "erreur voulue`n")
    Assert-Test 'banc : nombre d usages puis regle suivante' ((Invoke-CockpitDocker '' @('une-fois') 30).StdOut -ceq 'premier' -and (Invoke-CockpitDocker '' @('une-fois') 30).StdOut -ceq 'suivant')
    $r = Invoke-CockpitDocker '' @('load', '--input', 'x.tar.gz') 30
    Assert-Test 'banc : appel interdit -> code 97, forbidden au journal' ($r.ExitCode -eq 97 -and [bool]@(Get-DockerJournal)[-1].forbidden)
    Assert-Test 'banc : appel sans regle -> code 99' ((Invoke-CockpitDocker '' @('volume', 'ls') 30).ExitCode -eq 99)
    Set-Env 'COCKPIT_TOKEN' $SavedEnv['COCKPIT_TOKEN']
    Set-Env 'COCKPIT_LOCAL_SCHEME' $SavedEnv['COCKPIT_LOCAL_SCHEME']
    Set-Env 'WORKSPACE_DIR' $SavedEnv['WORKSPACE_DIR']

    # --- Lecteur de certificat --------------------------------------------------------------------------------------
    Write-Section 'Lecteur du certificat public'
    $pemA = $Certs['A'].PemText
    $bodyA = ($pemA -split "`n" | Where-Object { $_ -and $_ -notmatch '-----' }) -join ''
    Assert-Test 'PEM : lot de deux certificats refuse' ($null -ne (Invoke-Captured { ConvertFrom-CockpitPem ($pemA + $Certs['B'].PemText) }).Error)
    Assert-Test 'PEM : DER brut refuse' ($null -ne (Invoke-Captured { ConvertFrom-CockpitPem ([System.Text.Encoding]::GetEncoding(28591).GetString([Convert]::FromBase64String($bodyA))) }).Error)
    Assert-Test 'PEM : texte avec PRIVATE KEY refuse' ($null -ne (Invoke-Captured { ConvertFrom-CockpitPem ($pemA + '-----BEGIN ' + 'PRIVATE KEY-----') }).Error)
    Assert-Test 'PEM : tronque refuse' ($null -ne (Invoke-Captured { ConvertFrom-CockpitPem ("-----BEGIN CERTIFICATE-----`n" + $bodyA.Substring(0, 60) + "QUJ`n-----END CERTIFICATE-----") }).Error)
    Assert-Test 'PEM : vide refuse' ($null -ne (Invoke-Captured { ConvertFrom-CockpitPem '   ' }).Error)
    Assert-Test 'PEM : CRLF accepte' ((ConvertFrom-CockpitPem ($pemA.Replace("`n", "`r`n"))).Length -gt 100)
    Assert-Test 'PEM : BOM accepte' ((ConvertFrom-CockpitPem ([string][char]0xFEFF + $pemA)).Length -gt 100)
    Assert-Test 'etat TLS : empreintes du certificat A' ($StateA.Sha256Hex -ceq $Certs['A'].Sha256Hex -and $StateA.Sha256 -cmatch '^([0-9A-F]{2}:){31}[0-9A-F]{2}\z' -and $StateA.HasIp127)
    $jsonB = ConvertFrom-Json $Certs['B'].JsonText
    $mixed = ConvertFrom-Json $Certs['A'].JsonText
    $mixed.sha256Hex = $jsonB.sha256Hex
    Assert-Test 'etat TLS : sha256Hex different -> exception' ($null -ne (Invoke-Captured { ConvertTo-CockpitTlsState $pemA (ConvertTo-Json $mixed) }).Error)
    $mixed = ConvertFrom-Json $Certs['A'].JsonText
    $mixed.spkiSha256Base64 = $jsonB.spkiSha256Base64
    Assert-Test 'etat TLS : SPKI different -> exception' ($null -ne (Invoke-Captured { ConvertTo-CockpitTlsState $pemA (ConvertTo-Json $mixed) }).Error)
    Assert-Test 'etat TLS : JSON incomplet -> exception' ($null -ne (Invoke-Captured { ConvertTo-CockpitTlsState $pemA '{"schema":1}' }).Error)
    Assert-Test 'avertissements : certificat valable sans avertissement' (@(Get-CockpitCertWarnings $StateA).Count -eq 0)
    Assert-Test 'avertissements : expire bloquant' (@(Get-CockpitCertWarnings $StateExpire | Where-Object { $_.Code -ceq 'expire' -and $_.Blocking }).Count -eq 1)
    Assert-Test 'avertissements : SAN DNS seul bloquant' (@(Get-CockpitCertWarnings $StateDns | Where-Object { $_.Code -ceq 'san' -and $_.Blocking }).Count -eq 1)
    Assert-Test 'avertissements : echeance proche non bloquante' (@(Get-CockpitCertWarnings $StateA $StateA.NotAfter.AddDays(-10) | Where-Object { $_.Code -ceq 'echeance' -and -not $_.Blocking }).Count -eq 1)

    # --- Voie curl HTTPS -----------------------------------------------------------------------------------------------
    Write-Section 'Voie curl HTTPS'
    $curlInfo = Get-CockpitCurl
    Assert-Test 'curl.exe de Windows : >= 7.60 avec Schannel' $curlInfo.Available $curlInfo.Reason
    Assert-Test 'curl 7.55 : trop ancien' ((Get-CockpitCurl (Join-Path $FakeCurl 'curl755.cmd')).Reason -ceq 'version 7.55.1 anterieure a 7.60')
    Assert-Test 'curl sans Schannel' ((Get-CockpitCurl (Join-Path $FakeCurl 'curl-openssl.cmd')).Reason -ceq 'sans Schannel')
    Assert-Test 'curl absent' ((Get-CockpitCurl (Join-Path $Work 'absent.exe')).Reason -ceq 'absent')
    function Test-Https($State, [int]$Port, [string[]]$Methods, [bool]$Healthy = $false, [string]$CurlPath = '') {
        return (Test-CockpitHealth -Port $Port -Mode 'https' -Token $Token -TlsState $State -Methods $Methods -ContainerHealthy $Healthy -CurlPath $CurlPath -TimeoutSec 4)
    }
    function Test-HttpsMatrix([string]$Method) {
        $r = Test-Https $StateA $Ports.A @($Method)
        Assert-Test "$Method : certificat A -> Ok" ($r.Reason -ceq 'Ok' -and $r.Method -ceq $Method -and $r.Version -ceq '1.0.5') ($r.Reason + ' ' + $r.Detail)
        $r = Test-Https $StateA $Ports.B @($Method)
        Assert-Test "$Method : serveur B -> EmpreinteDifferente" ($r.Reason -ceq 'EmpreinteDifferente') ($r.Reason + ' ' + $r.Detail)
        $r = Test-Https $StateExpire $Ports.expire @($Method)
        Assert-Test "$Method : certificat expire -> CertificatRefuse" ($r.Reason -ceq 'CertificatRefuse') ($r.Reason + ' ' + $r.Detail)
        $r = Test-Https $StateDns $Ports.dns @($Method)
        Assert-Test "$Method : SAN DNS seul -> CertificatRefuse" ($r.Reason -ceq 'CertificatRefuse') ($r.Reason + ' ' + $r.Detail)
        $r = Test-Https $StateA $ClosedPort @($Method)
        Assert-Test "$Method : port ferme -> NonDisponible, reessai" ($r.Reason -ceq 'NonDisponible' -and $r.Retry) ($r.Reason + ' ' + $r.Detail)
        $r = Test-Https $StateA $Ports.close @($Method)
        Assert-Test "$Method : ecouteur qui ferme -> Poignee, reessai avant healthy" ($r.Reason -ceq 'Poignee' -and $r.Retry) ($r.Reason + ' ' + $r.Detail)
        $r = Test-Https $StateA $Ports.close @($Method) $true
        Assert-Test "$Method : Poignee definitive apres healthy" ($r.Reason -ceq 'Poignee' -and -not $r.Retry)
        $r = Test-Https $StateA $Ports.A12 @($Method)
        Assert-Test "$Method : serveur limite a TLS 1.2 -> Ok" ($r.Reason -ceq 'Ok') ($r.Reason + ' ' + $r.Detail)
        foreach ($proxyName in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) { Set-Env $proxyName 'http://127.0.0.1:9' }
        $r = Test-Https $StateA $Ports.A @($Method)
        foreach ($proxyName in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) { Set-Env $proxyName $SavedEnv[$proxyName] }
        Assert-Test "$Method : proxy mort dans l environnement -> Ok" ($r.Reason -ceq 'Ok') ($r.Reason + ' ' + $r.Detail)
        Set-Behavior @{} @{ redirect = $true }
        $r = Test-Https $StateA $Ports.A @($Method)
        Set-Behavior @{}
        Assert-Test "$Method : redirection jamais suivie -> Refus (302)" ($r.Reason -ceq 'Refus' -and $r.Status -eq 302) ($r.Reason + ' ' + $r.Detail)
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $r = Test-CockpitHealth -Port $Ports.hang -Mode 'https' -Token $Token -TlsState $StateA -Methods @($Method) -TimeoutSec 2
        $watch.Stop()
        Assert-Test "$Method : serveur muet -> NonDisponible dans le delai" ($r.Reason -ceq 'NonDisponible' -and $watch.Elapsed.TotalSeconds -lt 7) ('{0} {1:N1} s' -f $r.Reason, $watch.Elapsed.TotalSeconds)
    }
    Test-HttpsMatrix 'curl'
    $r = Test-Https $StateA $Ports.B @('curl', 'csharp')
    Assert-Test 'raison definitive : jamais suivie d une autre voie (aucune compilation)' ($r.Reason -ceq 'EmpreinteDifferente' -and $r.Method -ceq 'curl' -and $null -eq ('OpencodeCockpit.PinnedHttp' -as [type])) ($r.Reason + ' ' + $r.Method)
    $fakeSpki = $StateA.PSObject.Copy()
    $fakeSpki.SpkiBase64 = $StateB.SpkiBase64
    $r = Test-Https $fakeSpki $Ports.A @('curl')
    Assert-Test 'curl : SPKI faux -> EmpreinteDifferente' ($r.Reason -ceq 'EmpreinteDifferente') ($r.Reason + ' ' + $r.Detail)
    Assert-Test 'requete de sante mal formee refusee' ($null -ne (Invoke-Captured { Invoke-CockpitHealthCurl 'https' $Ports.A 'challenge=1' $StateA $RealCurl 4 }).Error)
    Set-Env 'COCKPIT_TEST_CURL_LOG' (Join-Path $Work 'curl-args.jsonl')
    $r = Test-Https $StateA $Ports.A @('curl') $false (Join-Path $FakeCurl 'curl-log.cmd')
    $logged = @()
    foreach ($line in @(Get-Content -LiteralPath (Join-Path $Work 'curl-args.jsonl'))) { $array = @(); foreach ($item in (ConvertFrom-Json $line)) { $array += [string]$item }; if ($array -contains '--cacert') { $logged = $array } }
    Assert-Test 'curl consigne : sante Ok' ($r.Reason -ceq 'Ok') ($r.Reason + ' ' + $r.Detail)
    Assert-Test 'curl : --disable en premier argument' ($logged.Count -gt 0 -and $logged[0] -ceq '--disable')
    $joinedArgs = $logged -join ' '
    Assert-Test 'curl : --noproxy 127.0.0.1, --proto =https, --pinnedpubkey sha256//' ($joinedArgs.Contains('--noproxy 127.0.0.1') -and $joinedArgs.Contains('--proto =https') -and $joinedArgs.Contains('--pinnedpubkey sha256//' + $StateA.SpkiBase64))
    $caIndex = [Array]::IndexOf($logged, '--cacert')
    Assert-Test 'curl : fichier du certificat public supprime apres usage' ($caIndex -ge 0 -and -not (Test-Path -LiteralPath $logged[$caIndex + 1]))
    Set-Env 'COCKPIT_TEST_CURL_LOG' $null
    $rcDir = Join-Path $Work 'curlrc'
    New-Item -ItemType Directory -Path $rcDir | Out-Null
    foreach ($rcName in @('_curlrc', '.curlrc')) { [System.IO.File]::WriteAllText((Join-Path $rcDir $rcName), ('connect-to = "::127.0.0.1:{0}"' -f $Ports.B) + "`nlocation`n") }
    foreach ($homeName in @('CURL_HOME', 'HOME', 'APPDATA')) { Set-Env $homeName $rcDir }
    $control = Invoke-CockpitProcess -FilePath $RealCurl -Arguments @('--silent', '--noproxy', '127.0.0.1', '--cacert', (Join-Path $certDir 'A.crt'), ('https://127.0.0.1:{0}/api/health' -f $Ports.A)) -TimeoutSec 10
    $r = Test-Https $StateA $Ports.A @('curl')
    foreach ($homeName in @('CURL_HOME', 'HOME', 'APPDATA')) { Set-Env $homeName $SavedEnv[$homeName] }
    Assert-Test 'temoin : le _curlrc detourne un curl lance sans --disable' ($control.ExitCode -ne 0) ('code ' + $control.ExitCode)
    Assert-Test 'curl : _curlrc (--connect-to, -L) ignore grace a --disable' ($r.Reason -ceq 'Ok') ($r.Reason + ' ' + $r.Detail)

    # --- Voies HTTP (avant toute compilation : le compte des assemblages dynamiques verifie qu'aucun Add-Type n'a lieu) ---
    Write-Section 'Voies HTTP (native puis curl)'
    function Test-Http([string[]]$Methods, [int]$Port = $Ports.plain, [bool]$Healthy = $false) {
        return (Test-CockpitHealth -Port $Port -Mode 'http' -Token $Token -TlsState $null -Methods $Methods -ContainerHealthy $Healthy -TimeoutSec 4)
    }
    Assert-Test 'HTTP : classe C# pas encore chargee' ($null -eq ('OpencodeCockpit.PinnedHttp' -as [type]))
    $dynamicBefore = Get-DynamicAssemblyCount
    $protocolBefore = [System.Net.ServicePointManager]::SecurityProtocol
    $proxyBefore = [System.Net.WebRequest]::DefaultWebProxy
    $default = Invoke-Captured { Set-Behavior @{}; Test-CockpitHealth -Port $Ports.plain -Mode 'http' -Token $Token }
    Assert-Test 'HTTP : voie native par defaut, sans A8' ($default.Values[0].Reason -ceq 'Ok' -and $default.Values[0].Method -ceq 'native' -and -not $default.Host.Contains('Voie de secours'))
    $cases = @(
        @(@{}, 'Ok', $Ports.plain), @(@{ proof = 'bad' }, 'PreuveInvalide', $Ports.plain), @(@{ proof = 'absent' }, 'PreuveInvalide', $Ports.plain),
        @(@{ proof = 'null' }, 'JetonHorsFormat', $Ports.plain), @(@{ scheme = 'https' }, 'SchemaDifferent', $Ports.plain), @(@{ scheme = 'none' }, 'ImageAncienne', $Ports.plain),
        @(@{ version = '1.0.4' }, 'ImageAncienne', $Ports.plain), @(@{ status = 503 }, 'Refus', $Ports.plain), @(@{ raw = 'pas du json' }, 'Refus', $Ports.plain),
        @(@{}, 'NonDisponible', $ClosedPort), @(@{}, 'Poignee', $Ports.close), @(@{ proof = 'upper' }, 'PreuveInvalide', $Ports.plain), @(@{ redirect = $true }, 'Refus', $Ports.plain))
    foreach ($method in @('native', 'curl')) {
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        $r = Test-CockpitHealth -Port $Ports.hang -Mode 'http' -Token $Token -Methods @($method) -TimeoutSec 2
        $watch.Stop()
        Assert-Test "$method : serveur muet -> NonDisponible dans le delai" ($r.Reason -ceq 'NonDisponible' -and $r.Method -ceq $method -and $watch.Elapsed.TotalSeconds -lt 7) ('{0} {1:N1} s' -f $r.Reason, $watch.Elapsed.TotalSeconds)
        foreach ($case in $cases) {
            Set-Behavior $case[0]
            $r = Test-Http @($method) $case[2]
            Assert-Test ('{0} : {1} -> {2}' -f $method, (ConvertTo-Json -Compress $case[0]), $case[1]) ($r.Reason -ceq $case[1] -and $r.Method -ceq $method) ($r.Reason + ' ' + $r.Detail)
        }
        Set-Behavior @{ proof = 'bad' }
        Assert-Test "$method : PreuveInvalide reessayee avant healthy seulement" ((Test-Http @($method)).Retry -and -not (Test-Http @($method) $Ports.plain $true).Retry)
        Set-Behavior @{}
        foreach ($proxyName in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) { Set-Env $proxyName 'http://127.0.0.1:9' }
        $r = Test-Http @($method)
        foreach ($proxyName in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) { Set-Env $proxyName $SavedEnv[$proxyName] }
        Assert-Test "$method : proxy mort dans l environnement -> Ok" ($r.Reason -ceq 'Ok') ($r.Reason + ' ' + $r.Detail)
    }
    Set-Behavior @{ proof = 'bad' }
    $r = Test-Http @('native', 'curl')
    Assert-Test 'HTTP : raison definitive de la voie native, curl jamais essaye' ($r.Reason -ceq 'PreuveInvalide' -and $r.Method -ceq 'native') ($r.Reason + ' ' + $r.Method)
    Set-Behavior @{ version = ('1.0.5' + [char]27 + '[31m' + ('9' * 60)) }
    $r = Test-Http @('native')
    Assert-Test 'version venue du reseau : caracteres de version seulement, 32 au plus' ($r.Reason -ceq 'Ok' -and $r.Version -cmatch '^1\.0\.5[0-9A-Za-z.+-]{0,27}\z') $r.Version
    Set-Behavior @{}
    Assert-Test 'HTTP : jamais la voie C#' ($null -ne (Invoke-Captured { Test-Http @('csharp') }).Error)
    $dynamicAfter = Get-DynamicAssemblyCount
    Assert-Test 'HTTP : aucun assemblage dynamique charge' ($dynamicAfter -eq $dynamicBefore) ('{0} -> {1}' -f $dynamicBefore, $dynamicAfter)
    Assert-Test 'HTTP : aucun A8, classe C# jamais compilee' (-not $CockpitTlsSession.A8Shown -and $null -eq ('OpencodeCockpit.PinnedHttp' -as [type]))
    Assert-Test 'HTTP : etat global .NET inchange' ([System.Net.ServicePointManager]::SecurityProtocol -eq $protocolBefore -and [object]::ReferenceEquals($proxyBefore, [System.Net.WebRequest]::DefaultWebProxy) -and $null -eq [System.Net.ServicePointManager]::ServerCertificateValidationCallback)

    # --- Voie C# ------------------------------------------------------------------------------------------------------
    Write-Section 'Voie C# (Add-Type)'
    $protocolBefore = [System.Net.ServicePointManager]::SecurityProtocol
    $proxyBefore = [System.Net.WebRequest]::DefaultWebProxy
    Assert-Test 'classe C# pas encore chargee' ($null -eq ('OpencodeCockpit.PinnedHttp' -as [type]))
    $none = Invoke-Captured { function Add-Type { throw 'Add-Type bloque (espion)' }; Test-Https $StateA $Ports.A @('curl', 'csharp') $false (Join-Path $Work 'absent.exe') }
    Assert-Test 'curl absent et Add-Type bloque -> AucuneVoie' ($none.Values.Count -eq 1 -and $none.Values[0].Reason -ceq 'AucuneVoie' -and $none.Values[0].Detail.Contains('curl.exe : absent') -and $none.Values[0].Detail.Contains('Add-Type bloque')) $none.Error
    Assert-Test 'A8 affiche avant la tentative de compilation' ($none.Host.Contains('curl.exe indisponible (absent)'))
    $CockpitTlsSession.A8Shown = $false
    $CockpitTlsSession.AddTypeError = $null
    $dynamicBeforeCompile = Get-DynamicAssemblyCount
    $first = Invoke-Captured { Test-Https $StateA $Ports.A @('curl', 'csharp') $false (Join-Path $FakeCurl 'curl755.cmd') }
    Assert-Test 'curl 7.55 -> voie C# Ok' ($first.Values.Count -eq 1 -and $first.Values[0].Reason -ceq 'Ok' -and $first.Values[0].Method -ceq 'csharp') $first.Error
    Assert-Test 'temoin : une compilation Add-Type se voit dans le compte des assemblages dynamiques' ((Get-DynamicAssemblyCount) -gt $dynamicBeforeCompile)
    Assert-Test 'A8 : une fois, raison et script lanceur' (([regex]::Matches($first.Host, 'Voie de secours')).Count -eq 1 -and $first.Host.Contains('version 7.55.1 anterieure a 7.60') -and $first.Host.Contains('lancee par Test-CockpitTls.ps1'))
    $second = Invoke-Captured { Test-Https $StateA $Ports.A @('curl', 'csharp') $false (Join-Path $FakeCurl 'curl755.cmd') }
    Assert-Test 'A8 : jamais une seconde fois dans le processus' ($second.Values[0].Reason -ceq 'Ok' -and -not $second.Host.Contains('Voie de secours'))
    Test-HttpsMatrix 'csharp'
    Assert-Test 'I9 : aucun rappel global de certificat' ($null -eq [System.Net.ServicePointManager]::ServerCertificateValidationCallback)
    Assert-Test 'I9 : SecurityProtocol inchange' ([System.Net.ServicePointManager]::SecurityProtocol -eq $protocolBefore)
    Assert-Test 'I9 : DefaultWebProxy inchange' ([object]::ReferenceEquals($proxyBefore, [System.Net.WebRequest]::DefaultWebProxy))
    $iwrStatus = ''
    try { Invoke-WebRequest -UseBasicParsing -Uri ('https://127.0.0.1:{0}/api/health' -f $Ports.A) -TimeoutSec 5 | Out-Null; $iwrStatus = 'accepte' } catch {
        $web = $_.Exception
        while ($null -ne $web -and -not ($web -is [System.Net.WebException])) { $web = $web.InnerException }
        if ($null -ne $web) { $iwrStatus = [string]$web.Status }
    }
    Assert-Test 'I9 : Invoke-WebRequest vers A toujours refuse (TrustFailure)' ($iwrStatus -ceq 'TrustFailure') $iwrStatus

    # --- Wait-CockpitHealth -------------------------------------------------------------------------------------------
    Write-Section 'Wait-CockpitHealth'
    function Measure-Wait([scriptblock]$Block) { $watch = [System.Diagnostics.Stopwatch]::StartNew(); $value = & $Block; $watch.Stop(); return [pscustomobject]@{ Health = $value; Seconds = $watch.Elapsed.TotalSeconds } }
    $m = Measure-Wait { Wait-CockpitHealth -Root '' -Port $ClosedPort -Mode 'http' -Token $Token -TimeoutSec 3 -PollSec 1 }
    Assert-Test 'NonDisponible reessayee jusqu au delai, tenu a 1 s pres' ($m.Health.Reason -ceq 'NonDisponible' -and [Math]::Abs($m.Seconds - 3) -le 1) ('{0:N2} s' -f $m.Seconds)
    Set-Behavior @{ proof = 'bad' }
    $m = Measure-Wait { Wait-CockpitHealth -Root '' -Port $Ports.plain -Mode 'http' -Token $Token -TimeoutSec 3 -PollSec 1 }
    Assert-Test 'PreuveInvalide avant healthy : reessayee jusqu au delai' ($m.Health.Reason -ceq 'PreuveInvalide' -and [Math]::Abs($m.Seconds - 3) -le 1) ('{0:N2} s' -f $m.Seconds)
    Set-Behavior @{ scheme = 'https' }
    $m = Measure-Wait { Wait-CockpitHealth -Root '' -Port $Ports.plain -Mode 'http' -Token $Token -TimeoutSec 10 -PollSec 1 }
    Assert-Test 'SchemaDifferent : definitive, sans reessai' ($m.Health.Reason -ceq 'SchemaDifferent' -and $m.Seconds -lt 3) ('{0:N2} s' -f $m.Seconds)
    $cockpitDir = Join-Path $Work 'cockpit'
    New-Item -ItemType Directory -Path $cockpitDir | Out-Null
    foreach ($name in @('A', 'B')) { [System.IO.File]::WriteAllText((Join-Path $certDir "$name.json"), $Certs[$name].JsonText) }
    $healthyRules = @((New-Rule '^compose -f \S.* ps -q cockpit$' "0123456789abcdef`n"), (New-Rule '^inspect --format \{\{\.State\.Health\.Status\}\} 0123456789abcdef$' "healthy`n"))
    function New-CatRule([string]$File, [string]$Cert, $Uses = $null) { return (New-Rule ('^compose -f \S.* exec -T cockpit cat /tls/public/' + [regex]::Escape($File) + '$') '' 0 $Uses (Join-Path $certDir $Cert)) }
    Set-DockerScenario ($healthyRules + @((New-Rule 'printenv COCKPIT_LOCAL_SCHEME$' "http`n")))
    Set-Behavior @{ proof = 'bad' }
    $m = Measure-Wait { Wait-CockpitHealth -Root $cockpitDir -Port $Ports.plain -Mode 'http' -Token $Token -TimeoutSec 30 -PollSec 1 }
    Assert-Test 'PreuveInvalide apres healthy : definitive' ($m.Health.Reason -ceq 'PreuveInvalide' -and $m.Health.ContainerHealth -ceq 'healthy' -and $m.Seconds -lt 15) ('{0:N2} s' -f $m.Seconds)
    $m = Measure-Wait { Wait-CockpitHealth -Root $cockpitDir -Port $Ports.close -Mode 'http' -Token $Token -TimeoutSec 30 -PollSec 1 }
    Assert-Test 'Poignee apres healthy, schema servi identique -> Refus' ($m.Health.Reason -ceq 'Refus') $m.Health.Reason
    Set-DockerScenario ($healthyRules + @((New-Rule 'printenv COCKPIT_LOCAL_SCHEME$' "https`n")))
    $m = Measure-Wait { Wait-CockpitHealth -Root $cockpitDir -Port $Ports.close -Mode 'http' -Token $Token -TimeoutSec 30 -PollSec 1 }
    Assert-Test 'Poignee apres healthy, schema servi https -> SchemaDifferent' ($m.Health.Reason -ceq 'SchemaDifferent' -and $m.Health.Detail -ceq 'schema servi : https') $m.Health.Reason
    Set-Behavior @{}
    Set-DockerScenario ($healthyRules + @((New-CatRule 'cockpit.crt' 'A.crt'), (New-CatRule 'cockpit-tls.json' 'A.json')))
    $m = Measure-Wait { Wait-CockpitHealth -Root $cockpitDir -Port $Ports.A -Mode 'https' -Token $Token -TimeoutSec 30 -PollSec 1 }
    Assert-Test 'HTTPS : certificat public lu par docker, sante Ok' ($m.Health.Reason -ceq 'Ok' -and $m.Health.TlsState.Sha256Hex -ceq $Certs['A'].Sha256Hex) ($m.Health.Reason + ' ' + $m.Health.Detail)
    Set-DockerScenario ($healthyRules + @((New-CatRule 'cockpit.crt' 'B.crt' 1), (New-CatRule 'cockpit-tls.json' 'B.json' 1), (New-CatRule 'cockpit.crt' 'A.crt'), (New-CatRule 'cockpit-tls.json' 'A.json')))
    $m = Measure-Wait { Wait-CockpitHealth -Root $cockpitDir -Port $Ports.A -Mode 'https' -Token $Token -TimeoutSec 30 -PollSec 1 }
    $catCount = @(Get-DockerJournal | Where-Object { ($_.args -join ' ').EndsWith('cockpit.crt') }).Count
    Assert-Test 'EmpreinteDifferente : une relecture du certificat public puis Ok' ($m.Health.Reason -ceq 'Ok' -and $catCount -eq 2) ('{0}, {1} lecture(s)' -f $m.Health.Reason, $catCount)
    Set-DockerScenario ($healthyRules + @((New-CatRule 'cockpit.crt' 'B.crt'), (New-CatRule 'cockpit-tls.json' 'B.json')))
    $m = Measure-Wait { Wait-CockpitHealth -Root $cockpitDir -Port $Ports.A -Mode 'https' -Token $Token -TimeoutSec 30 -PollSec 1 }
    $catCount = @(Get-DockerJournal | Where-Object { ($_.args -join ' ').EndsWith('cockpit.crt') }).Count
    Assert-Test 'EmpreinteDifferente persistante : definitive apres une seule relecture' ($m.Health.Reason -ceq 'EmpreinteDifferente' -and $catCount -eq 2) ('{0}, {1} lecture(s)' -f $m.Health.Reason, $catCount)
    Set-DockerScenario ($healthyRules + @((New-CatRule 'cockpit.crt' 'A.crt'), (New-CatRule 'cockpit-tls.json' 'B.json')))
    $m = Measure-Wait { Wait-CockpitHealth -Root $cockpitDir -Port $Ports.A -Mode 'https' -Token $Token -TimeoutSec 30 -PollSec 1 }
    Assert-Test 'certificat public incoherent apres healthy : arret immediat, aucune sante' ($m.Health.Reason -ceq 'Refus' -and $m.Health.Detail.Contains('Incoherence') -and -not $m.Health.Retry -and $m.Seconds -lt 15) ('{0} {1:N1} s' -f $m.Health.Detail, $m.Seconds)
    Set-DockerScenario @((New-Rule '^compose -f \S.* ps -q cockpit$' '' 0), (New-Rule 'cat /tls/public/' '' 1))
    $m = Measure-Wait { Wait-CockpitHealth -Root $cockpitDir -Port $Ports.A -Mode 'https' -Token $Token -TimeoutSec 2 -PollSec 1 }
    Assert-Test 'certificat public absent : NonDisponible au delai' ($m.Health.Reason -ceq 'NonDisponible' -and $m.Health.Detail.Contains('certificat public')) $m.Health.Detail

    # --- Get-CockpitLoginUrl [Q7] -------------------------------------------------------------------------------------
    Write-Section 'Get-CockpitLoginUrl (ticket)'
    Set-Behavior @{}
    $okHttp = Test-Http @('native')
    $login = Invoke-Captured { Get-CockpitLoginUrl -Health $okHttp -Port $Ports.plain -Mode 'http' -Token $Token }
    $url = [string]$login.Values[0].Url
    $match = [regex]::Match($url, '^http://127\.0\.0\.1:([0-9]+)/auth\?k=([0-9a-f]{64})\.([0-9a-f]{64})$')
    Assert-Test 'ticket : URL /auth?k=<nonce>.<mac>' ($match.Success -and [int]$match.Groups[1].Value -eq $Ports.plain)
    Assert-Test 'ticket : signature auth-ticket du jeton' ($match.Success -and $match.Groups[3].Value -ceq (Get-CockpitHmacHex $Token 'auth-ticket' $match.Groups[2].Value))
    Assert-Test 'ticket : jeton absent de l URL, rien d affiche' (-not $url.Contains($Token) -and $login.Host -ceq '' -and $login.Values.Count -eq 1)
    $lastRequest = @(Get-Content -LiteralPath $ServerLog | Where-Object { $_ } | ForEach-Object { ConvertFrom-Json $_ } | Where-Object { $_.listener -ceq 'plain' -and $_.challenge }) | Select-Object -Last 1
    Assert-Test 'ticket : demande signee par le jeton (HMAC auth-ticket-request du defi)' ($null -ne $lastRequest -and $lastRequest.ticket -and $lastRequest.ticketSigned)
    $outOfFormat = Test-CockpitHealth -Port $Ports.plain -Mode 'http' -Token ('a' * 40) -TlsState $null -Methods @('native') -WithTicket -TimeoutSec 4
    $lastRequest = @(Get-Content -LiteralPath $ServerLog | Where-Object { $_ } | ForEach-Object { ConvertFrom-Json $_ } | Where-Object { $_.listener -ceq 'plain' -and $_.challenge }) | Select-Object -Last 1
    Assert-Test 'ticket : aucune demande envoyee avec un jeton hors format' ($null -ne $lastRequest -and -not $lastRequest.ticket -and $outOfFormat.Ticket -ceq '') $outOfFormat.Reason
    $unsignedRaw = Invoke-CockpitHealthNative $Ports.plain ('challenge=' + ('c' * 64) + '&ticket=' + ('0' * 64)) 4000
    Assert-Test 'banc : srv-test refuse comme le serveur une demande de ticket non signee (403, aucun ticket)' ($unsignedRaw.Status -eq 403 -and -not $unsignedRaw.Body.Contains('"ticket"')) ([string]$unsignedRaw.Status)
    foreach ($bad in @(@(@{ ticket = 'bad' }, 'TicketInvalide'), @(@{ ticket = 'none' }, 'TicketInvalide'), @(@{ proof = 'bad' }, 'PreuveInvalide'))) {
        Set-Behavior $bad[0]
        $refused = Get-CockpitLoginUrl -Health $okHttp -Port $Ports.plain -Mode 'http' -Token $Token
        Assert-Test ('ticket : {0} -> aucune URL ({1})' -f (ConvertTo-Json -Compress $bad[0]), $bad[1]) ($null -eq $refused.Url -and $refused.Reason -ceq $bad[1]) $refused.Reason
    }
    Set-Behavior @{}
    Assert-Test 'ticket : sante non Ok -> aucune URL' ($null -eq (Get-CockpitLoginUrl -Health (New-CockpitHealth 'PreuveInvalide' '') -Port $Ports.plain -Mode 'http' -Token $Token).Url)
    $okHttps = Test-Https $StateA $Ports.A @('curl')
    $secureLogin = Get-CockpitLoginUrl -Health $okHttps -Port $Ports.A -Mode 'https' -Token $Token -TlsState $StateA
    Assert-Test 'ticket HTTPS : meme voie epinglee, URL https' ([string]$secureLogin.Url -cmatch '^https://127\.0\.0\.1:[0-9]+/auth\?k=[0-9a-f]{64}\.[0-9a-f]{64}$') $secureLogin.Reason

    # --- Decision d'ouverture, transitions, pre-controles (K2-1, K2-2) ------------------------------------------------
    Write-Section 'Decision d ouverture, transitions, pre-controles'
    $policyBlocked = [pscustomobject]@{ Verdict = 'Bloque'; Source = 'HKLM'; Origin = (Get-CockpitBaseUrl 'https' 7777); Port = 7777 }
    $policyOf = { param([string]$Verdict) [pscustomobject]@{ Verdict = $Verdict; Source = 'HKLM'; Origin = (Get-CockpitBaseUrl 'https' 7777); Port = 7777 } }
    $okHealth = New-CockpitHealth 'Ok' ''
    $decision = Get-CockpitOpenDecision $okHealth 'https' $policyBlocked
    Assert-Test 'K2-1 : HTTPS Ok + Bloque -> Open avec A2-Open' ($decision.Decision -ceq 'Open' -and @($decision.Lines).Count -eq 2 -and ($decision.Lines -join ' ').Contains("Le lien s'ouvre quand meme"))
    $decision = Get-CockpitOpenDecision $okHealth 'http' $policyBlocked
    Assert-Test 'HTTP Ok + Bloque -> Open sans avertissement' ($decision.Decision -ceq 'Open' -and @($decision.Lines).Count -eq 0)
    Assert-Test 'HTTPS Ok + AVerifier -> Open avec avertissement' (@((Get-CockpitOpenDecision $okHealth 'https' (& $policyOf 'AVerifier')).Lines).Count -eq 1)
    Assert-Test 'HTTPS Ok + Autorise -> Open' (@((Get-CockpitOpenDecision @{ Reason = 'Ok' } 'https' (& $policyOf 'Autorise')).Lines).Count -eq 0)
    foreach ($reason in @('NonDisponible', 'Poignee', 'EmpreinteDifferente', 'CertificatRefuse', 'Refus', 'ImageAncienne', 'SchemaDifferent', 'PreuveInvalide', 'JetonHorsFormat', 'AucuneVoie')) {
        Assert-Test ("I5 : $reason -> NotOk") ((Get-CockpitOpenDecision (New-CockpitHealth $reason '') 'https' (& $policyOf 'Autorise')).Decision -ceq 'NotOk')
    }
    $modeHttps = [pscustomobject]@{ Scheme = 'https'; Valid = $true }
    $modeHttpValid = [pscustomobject]@{ Scheme = 'http'; Valid = $true }
    $modeBroken = [pscustomobject]@{ Scheme = $null; Valid = $false }
    $transitions = @(
        @($modeHttps, $true, $false, '', 'EntreeHttps'), @($modeHttps, $true, $false, 'Http', 'EntreeHttp'), @($modeHttps, $true, $false, 'Https', 'EntreeHttps'),
        @($modeHttps, $false, $true, '', 'EntreeHttps'), @($modeHttps, $false, $true, 'Http', 'EntreeHttp'), @($modeHttps, $false, $true, 'Https', 'EntreeHttps'),
        @($modeHttps, $false, $false, '', 'ResteHttps'), @($modeHttps, $false, $false, 'Http', 'EntreeHttp'), @($modeHttps, $false, $false, 'Https', 'ResteHttps'),
        @($modeHttpValid, $false, $false, '', 'ResteHttp'), @($modeHttpValid, $false, $false, 'Http', 'ResteHttp'), @($modeHttpValid, $false, $false, 'Https', 'EntreeHttps'),
        @($modeHttpValid, $false, $true, '', 'ResteHttp'), @($modeBroken, $false, $false, '', 'Invalide'), @($modeBroken, $false, $false, 'Http', 'EntreeHttp'),
        @($modeBroken, $false, $false, 'Https', 'EntreeHttps'), @($modeBroken, $false, $true, '', 'Invalide'))
    foreach ($t in $transitions) {
        if ($t[3] -ceq 'Http') { $got = Get-CockpitTransition -Mode $t[0] -IsNew $t[1] -IsMigration $t[2] -Http }
        elseif ($t[3] -ceq 'Https') { $got = Get-CockpitTransition -Mode $t[0] -IsNew $t[1] -IsMigration $t[2] -Https }
        else { $got = Get-CockpitTransition -Mode $t[0] -IsNew $t[1] -IsMigration $t[2] }
        Assert-Test ('transition : {0} neuve={1} migration={2} -{3} -> {4}' -f $t[0].Scheme, $t[1], $t[2], $t[3], $t[4]) ($got -ceq $t[4]) $got
    }
    Assert-Test 'transition : -Http et -Https ensemble refuses' ($null -ne (Invoke-Captured { Get-CockpitTransition -Mode $modeHttps -IsNew $false -IsMigration $false -Http -Https }).Error)
    function Get-PrecheckCodes([string]$Transition, $Policy, [bool]$Accept, [bool]$Migration, [string]$Load, [int]$Port = 7777) {
        $mode = Get-CockpitLocalMode ([ordered]@{ COCKPIT_LOCAL_SCHEME = 'htps' })
        $r = Get-CockpitPrecheckProblems -Transition $Transition -Mode $mode -Policy $Policy -AcceptBrowserBlock $Accept -IsMigration $Migration -LoadProblem $Load -Port $Port -Version '1.0.5' -PreviousVersion '1.0.4'
        return [pscustomobject]@{ Codes = ((@($r.Problems | ForEach-Object { $_.Code }) -join ',') + '/' + (@($r.Warnings | ForEach-Object { $_.Code }) -join ',')); Result = $r
            Text = (@(@($r.Problems) + @($r.Warnings) | ForEach-Object { $_.Lines }) -join "`n") }
    }
    $load = 'image opencode-cockpit/app:1.0.4 en version 1.0.4, version 1.0.5 requise'
    $precheckCases = @(
        @('Invalide', $policyBlocked, $false, $true, $load, 'A18,A-Load,A2-Update/'), @('EntreeHttps', $policyBlocked, $false, $true, $load, 'A2,A-Load,A2-Load,A2-Update/'),
        @('EntreeHttps', $policyBlocked, $false, $true, '', 'A2,A2-Update/'), @('EntreeHttps', $policyBlocked, $true, $false, '', '/AcceptBrowserBlock'),
        @('ResteHttps', $policyBlocked, $false, $false, '', '/A2-Reste'), @('EntreeHttp', $policyBlocked, $false, $true, '', '/'), @('ResteHttp', $policyBlocked, $false, $false, '', '/'),
        @('EntreeHttps', (& $policyOf 'Couvert'), $false, $false, '', '/Couvert'), @('EntreeHttps', (& $policyOf 'AVerifier'), $false, $false, '', '/AVerifier'),
        @('ResteHttps', (& $policyOf 'AVerifier'), $false, $false, '', '/AVerifier'), @('EntreeHttps', (& $policyOf 'Autorise'), $false, $false, $load, 'A-Load/'),
        @('EntreeHttps', (& $policyOf 'Autorise'), $false, $true, '', '/'), @('EntreeHttps', $null, $false, $false, '', '/'), @('EntreeHttp', $policyBlocked, $false, $false, $load, 'A-Load/'),
        @('ResteHttps', $policyBlocked, $false, $false, $load, 'A-Load/'), @('EntreeHttps', $policyBlocked, $true, $false, $load, 'A-Load/'), @('EntreeHttps', (& $policyOf 'Couvert'), $false, $true, $load, 'A-Load,A2-Update/'))
    foreach ($c in $precheckCases) {
        $got = Get-PrecheckCodes $c[0] $c[1] $c[2] $c[3] $c[4]
        Assert-Test ('K2-2 pre-controles : {0} {1} accept={2} migration={3} load={4} -> {5}' -f $c[0], $(if ($null -ne $c[1]) { $c[1].Verdict } else { 'aucune' }), $c[2], $c[3], [bool]$c[4], $c[5]) ($got.Codes -ceq $c[5]) $got.Codes
    }
    $full = Get-PrecheckCodes 'EntreeHttps' $policyBlocked $false $true $load
    Assert-Test 'A2 : source, origine exacte et deux issues' ($full.Text.Contains('lue dans HKLM, aucune exception pour https://127.0.0.1:7777') -and $full.Text.Contains('SSLErrorOverrideAllowedForOrigins = https://127.0.0.1:7777,') -and $full.Text.Contains('.\install.ps1 -Http'))
    Assert-Test 'A-Load et A2-Load : archive de la version' ($full.Text.Contains('[!] Mode Load : ' + $load + '.') -and $full.Text.Contains('-ImagesArchive <opencode-cockpit-images-1.0.5.tar.gz> a la commande'))
    Assert-Test 'A2-Update : version precedente et adresse http' ($full.Text.Contains('restes en 1.0.4 et fonctionnent toujours sur http://127.0.0.1:7777') -and $full.Text.Contains('Pour retrouver les scripts 1.0.4'))
    Assert-Test 'A2 : port reel' ((Get-PrecheckCodes 'EntreeHttps' $policyBlocked $false $false '' 7778).Text.Contains('https://127.0.0.1:7778'))
    $invalidText = (Get-PrecheckCodes 'Invalide' $null $false $false '').Text
    Assert-Test 'A18 : cause sans la valeur lue' ($invalidText.Contains("[!] Mode d'acces invalide dans .env : valeur non reconnue.") -and -not $invalidText.Contains('htps'))
    Assert-Test 'messages ASCII seulement' (($full.Text + $invalidText) -cmatch '^[ -~\n]*\z')
    Assert-Test 'A19 exact' ($CockpitA19 -ceq 'Installation arretee avant toute modification (voir les messages ci-dessus).')

    # --- Strategies du navigateur -----------------------------------------------------------------------------------
    Write-Section 'Strategies du navigateur (racine de registre injectee, puis espions)'
    $roots = [ordered]@{ HKLM = ($TestRegistryRoot + '\machine'); HKCU = ($TestRegistryRoot + '\utilisateur') }
    Assert-Test 'racine de test hors de SOFTWARE\Policies' (($roots.HKLM + $roots.HKCU) -notmatch '(?i)policies')
    function Set-TestPolicy([string]$Hive, [string]$Browser, [string]$Name, $Value, [string]$Kind = 'DWord', [string[]]$Origins) {
        $sub = 'Microsoft\Edge'
        if ($Browser -ceq 'Chrome') { $sub = 'Google\Chrome' }
        $key = $roots[$Hive] + '\' + $sub
        if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
        if ($Name) { New-ItemProperty -LiteralPath $key -Name $Name -Value $Value -PropertyType $Kind -Force | Out-Null }
        if ($null -ne $Origins) {
            New-Item -Path ($key + '\SSLErrorOverrideAllowedForOrigins') -Force | Out-Null
            for ($i = 0; $i -lt $Origins.Count; $i++) { New-ItemProperty -LiteralPath ($key + '\SSLErrorOverrideAllowedForOrigins') -Name ([string]($i + 1)) -Value $Origins[$i] -PropertyType String -Force | Out-Null }
        }
    }
    function Reset-TestPolicy { if (Test-Path -LiteralPath $TestRegistryRoot) { Remove-Item -LiteralPath $TestRegistryRoot -Recurse -Force } }
    $policyCases = @(
        @('valeur absente', {}, 7777, 'Autorise', $null),
        @('0 sans liste', { Set-TestPolicy 'HKLM' 'Edge' 'SSLErrorOverrideAllowed' 0 }, 7777, 'Bloque', 'HKLM'),
        @('0 + :7777', { Set-TestPolicy 'HKLM' 'Edge' 'SSLErrorOverrideAllowed' 0 -Origins @('https://127.0.0.1:7777') }, 7777, 'Couvert', 'HKLM'),
        @('0 + :7778', { Set-TestPolicy 'HKLM' 'Edge' 'SSLErrorOverrideAllowed' 0 -Origins @('https://127.0.0.1:7778') }, 7777, 'Bloque', 'HKLM'),
        @('0 + sans port', { Set-TestPolicy 'HKLM' 'Edge' 'SSLErrorOverrideAllowed' 0 -Origins @('https://127.0.0.1') }, 7777, 'Couvert', 'HKLM'),
        @('0 + [*.]127.0.0.1', { Set-TestPolicy 'HKLM' 'Edge' 'SSLErrorOverrideAllowed' 0 -Origins @('[*.]127.0.0.1') }, 7777, 'AVerifier', 'HKLM'),
        @('0 + origine d entreprise et casse differente', { Set-TestPolicy 'HKLM' 'Edge' 'SSLErrorOverrideAllowed' 0 -Origins @('https://intranet.example.lu', 'HTTPS://127.0.0.1:7777/') }, 7777, 'Couvert', 'HKLM'),
        @('0 + origine d entreprise seule', { Set-TestPolicy 'HKLM' 'Edge' 'SSLErrorOverrideAllowed' 0 -Origins @('https://intranet.example.lu') }, 7777, 'Bloque', 'HKLM'),
        @('1', { Set-TestPolicy 'HKLM' 'Edge' 'SSLErrorOverrideAllowed' 1 }, 7777, 'Autorise', 'HKLM'),
        @('valeur inattendue 2', { Set-TestPolicy 'HKLM' 'Edge' 'SSLErrorOverrideAllowed' 2 }, 7777, 'AVerifier', 'HKLM'),
        @('HKCU 0', { Set-TestPolicy 'HKCU' 'Edge' 'SSLErrorOverrideAllowed' 0 }, 7777, 'Bloque', 'HKCU'),
        @('HKLM 1 prioritaire sur HKCU 0', { Set-TestPolicy 'HKLM' 'Edge' 'SSLErrorOverrideAllowed' 1; Set-TestPolicy 'HKCU' 'Edge' 'SSLErrorOverrideAllowed' 0 }, 7777, 'Autorise', 'HKLM'),
        @('liste lue dans la meme source', { Set-TestPolicy 'HKLM' 'Edge' 'SSLErrorOverrideAllowed' 0; Set-TestPolicy 'HKCU' 'Edge' '' $null -Origins @('https://127.0.0.1:7777') }, 7777, 'Bloque', 'HKLM'),
        @('port 7778 couvert', { Set-TestPolicy 'HKLM' 'Edge' 'SSLErrorOverrideAllowed' 0 -Origins @('https://127.0.0.1:7778') }, 7778, 'Couvert', 'HKLM'))
    foreach ($c in $policyCases) {
        Reset-TestPolicy
        & $c[1]
        $p = Get-CockpitBrowserTlsPolicy -Port $c[2] -RegistryRoots $roots
        Assert-Test ('strategie Edge : {0} -> {1}' -f $c[0], $c[3]) ($p.Verdict -ceq $c[3] -and $p.Source -ceq $c[4]) ('{0} {1}' -f $p.Verdict, $p.Source)
        $shown = Format-CockpitEdgePolicyValue $p
        $expectedShown = 'absente'; if ($null -ne $p.Value) { $expectedShown = [string]$p.Value }
        Assert-Test ('strategie Edge : {0} -> valeur affichee {1}' -f $c[0], $expectedShown) ($shown -ceq $expectedShown -and $shown -cne '' -and -not ('= {0},' -f $shown).Contains('= ,'))
    }
    Assert-Test 'valeur Edge affichee : absente sans strategie, jamais vide' ((Format-CockpitEdgePolicyValue ([pscustomobject]@{ Value = $null })) -ceq 'absente' -and (Format-CockpitEdgePolicyValue $null) -ceq 'absente' -and (Format-CockpitEdgePolicyValue ([pscustomobject]@{ Value = 0 })) -ceq '0')
    Reset-TestPolicy
    Set-TestPolicy 'HKLM' 'Chrome' 'SSLErrorOverrideAllowed' 0
    Set-TestPolicy 'HKCU' 'Edge' 'HttpsOnlyMode' 'force_enabled' 'String'
    $p = Get-CockpitBrowserTlsPolicy -Port 7777 -RegistryRoots $roots
    Assert-Test 'Chrome et HttpsOnlyMode : information seulement' ($p.Verdict -ceq 'Autorise' -and [string]$p.Chrome.Value -ceq '0' -and $p.Chrome.Source -ceq 'HKLM' -and @($p.HttpsOnly | Where-Object { $_.Name -ceq 'HttpsOnlyMode' -and $_.Value -ceq 'force_enabled' -and $_.Source -ceq 'HKCU' }).Count -eq 1)
    Reset-TestPolicy
    Assert-Test 'racine de registre de test supprimee' (-not (Test-Path -LiteralPath $TestRegistryRoot))
    $spied = Invoke-WithSpies { Set-SpyPolicy -Hive HKLM -Name SSLErrorOverrideAllowed -Value 0 -Origins @('https://127.0.0.1:7778') } { [pscustomobject]@{ Policy = (Get-CockpitBrowserTlsPolicy -Port 7777); Reads = @($SpyState.PolicyReads) } }
    Assert-Test 'espions : cles Policies simulees par racine par defaut' ($spied.Policy.Verdict -ceq 'Bloque' -and $spied.Policy.Source -ceq 'HKLM' -and $spied.Reads.Count -gt 0 -and @($spied.Policy.Origins).Count -eq 1)
    $spied = Invoke-WithSpies { Set-SpyPolicy -Hive HKCU -Name SSLErrorOverrideAllowed -Value 0; Set-SpyPolicy -Hive HKLM -Name SSLErrorOverrideAllowed -Value 1 } { Get-CockpitBrowserTlsPolicy -Port 7777 }
    Assert-Test 'racines par defaut : HKLM prioritaire sur HKCU' ($spied.Verdict -ceq 'Autorise' -and $spied.Source -ceq 'HKLM') ('{0} {1}' -f $spied.Verdict, $spied.Source)

    # --- Avis du mode HTTP et confirmation ----------------------------------------------------------------------------
    Write-Section 'Avis du mode HTTP et confirmation (espions, puis vrai Read-Host)'
    $modeHttp = Get-CockpitLocalMode ([ordered]@{ COCKPIT_LOCAL_SCHEME = 'http'; COCKPIT_LOCAL_HTTP_CONFIRMED = '2026-09-15T10:32:00Z' })
    $notice = Invoke-Captured { Write-CockpitModeNotice $modeHttp (& $policyOf 'Autorise') }
    Assert-Test 'A6 : date de confirmation et retour -Https' ($notice.Host.Contains('[!] MODE HTTP LOCAL (confirme le 2026-09-15 10:32 UTC avec -Http)') -and $notice.Host.Contains('.\install.ps1 -Https'))
    Assert-Test 'A6b : strategie Autorise' ($notice.Host.Contains('le mode HTTPS est probablement utilisable'))
    Assert-Test 'A6 sans A6b : strategie Bloque' (-not (Invoke-Captured { Write-CockpitModeNotice $modeHttp $policyBlocked }).Host.Contains('probablement utilisable'))
    $oneLine = Invoke-Captured { Write-CockpitModeNotice $modeHttp $null -OneLine }
    Assert-Test 'A6-1 : une ligne' ($oneLine.Host -cmatch '^\[!\] Mode HTTP local \(confirme le 2026-09-15 10:32 UTC\) : trafic en clair' -and -not $oneLine.Host.Contains("`n"))
    function Invoke-Confirm([object[]]$Answers, $Policy) {
        return (Invoke-WithSpies { foreach ($answer in $Answers) { Add-SpyReadHostAnswer $answer } } { [pscustomobject]@{ Run = (Invoke-Captured { Confirm-CockpitHttpMode 7777 $Policy }); Prompts = @($SpyState.ReadHostCalls) } })
    }
    $accepted = Invoke-Confirm @('HTTP EN CLAIR') $policyBlocked
    Assert-Test 'confirmation : texte exact accepte' ($null -eq $accepted.Run.Error -and $accepted.Prompts.Count -eq 1 -and $accepted.Prompts[0].StartsWith('Tapez HTTP EN CLAIR pour confirmer'))
    Assert-Test 'A5 : ce qui circule, qui peut lire, jamais le jeton dans une page' ($accepted.Run.Host.Contains('Ce qui circule EN CLAIR') -and $accepted.Run.Host.Contains('groupe docker-users') -and $accepted.Run.Host.Contains('Ne saisissez jamais le jeton dans une page') -and $accepted.Run.Host.Contains('http://127.0.0.1:7777 au lieu de https'))
    Assert-Test 'A5 [Q7] : pas de ligne sur le jeton dans le lien' (-not $accepted.Run.Host.Contains("lien d'ouverture."))
    Assert-Test 'A5 : ligne de strategie Bloque' ($accepted.Run.Host.Contains('HTTPS serait bloque dans Edge'))
    foreach ($verdictLine in @(@('Couvert', 'le mode HTTP est-il vraiment necessaire'), @('Autorise', 'aucune strategie bloquante trouvee'), @('AVerifier', 'exception de forme non reconnue'))) {
        Assert-Test ('A5 : ligne de strategie ' + $verdictLine[0]) ((Invoke-Confirm @('HTTP EN CLAIR') (& $policyOf $verdictLine[0])).Run.Host.Contains($verdictLine[1]))
    }
    foreach ($refusal in @('HTTP', 'http en clair', '', $null)) {
        $refused = Invoke-Confirm @(, $refusal) $policyBlocked
        Assert-Test ('confirmation refusee : [{0}]' -f $refusal) ($refused.Run.Error -ceq 'Installation annulee : mode HTTP non confirme. Aucun fichier modifie, mode inchange.') $refused.Run.Error
    }
    $nonInteractive = Invoke-Confirm @('<<espion:NonInteractive>>') $policyBlocked
    Assert-Test 'confirmation : espion -NonInteractive -> console interactive' ($nonInteractive.Run.Error -ceq 'Installation annulee : la confirmation du mode HTTP exige une console interactive (tapez HTTP EN CLAIR).') $nonInteractive.Run.Error
    $child = Join-Path $Work 'confirm-child.ps1'
    [System.IO.File]::WriteAllText($child, (". '" + (Join-Path $RepoRoot 'CockpitTls.ps1') + "'`r`ntry { Confirm-CockpitHttpMode 7777 `$null; 'ACCEPTE' } catch { 'REFUS : ' + `$_.Exception.Message }`r`n"), (New-Object System.Text.UTF8Encoding $true))
    $powershell = (Get-Command powershell.exe -CommandType Application | Select-Object -First 1).Source
    $real = Invoke-CockpitProcess -FilePath $powershell -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $child) -TimeoutSec 60
    Assert-Test 'P7 : vrai Read-Host sous -NonInteractive -> console interactive' ($real.StdOut.Contains('REFUS : Installation annulee : la confirmation du mode HTTP exige une console interactive')) ($real.StdOut + $real.StdErr).Trim()
    $real = Invoke-CockpitProcess -FilePath $powershell -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $child) -TimeoutSec 60
    Assert-Test 'P7 : vrai Read-Host, entree standard vide -> annulation' ($real.StdOut.Contains('REFUS : Installation annulee : mode HTTP non confirme')) ($real.StdOut + $real.StdErr).Trim()

    # Contrat des espions pour les lots 6 et 7 : actifs dans un script appele par &, avec son propre param et StrictMode (P6).
    $spyChild = Join-Path $Work 'spy-child.ps1'
    [System.IO.File]::WriteAllText($spyChild, (@('[CmdletBinding()]', 'param([string]$Dossier)', 'Set-StrictMode -Version 2.0', "`$ErrorActionPreference = 'Stop'",
            "`$answer = Read-Host 'Tapez REVENIR pour confirmer'", "Start-Process -FilePath 'espion-cible-inexistante.exe'",
            "`$key = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge'", "`$value = `$null", "if (Test-Path -LiteralPath `$key) { `$value = (Get-ItemProperty -LiteralPath `$key).SSLErrorOverrideAllowed }",
            "`$real = Test-Path -LiteralPath `$Dossier -PathType Container", "[pscustomobject]@{ Answer = `$answer; Policy = `$value; Real = `$real }") -join "`r`n"), (New-Object System.Text.UTF8Encoding $true))
    $spyRun = Invoke-WithSpies { Add-SpyReadHostAnswer 'REVENIR'; Set-SpyPolicy -Hive HKLM -Name SSLErrorOverrideAllowed -Value 0 } {
        [pscustomobject]@{ Out = (& $spyChild -Dossier $Work); Prompts = @($SpyState.ReadHostCalls); Started = @($SpyState.StartProcessCalls) } }
    Assert-Test 'espions dans un script appele par & : Read-Host et Start-Process interceptes' ($spyRun.Out.Answer -ceq 'REVENIR' -and $spyRun.Prompts.Count -eq 1 -and $spyRun.Started.Count -eq 1 -and $spyRun.Started[0].FilePath -ceq 'espion-cible-inexistante.exe')
    Assert-Test 'espions dans un script appele par & : strategie simulee, autres chemins delegues' ([string]$spyRun.Out.Policy -ceq '0' -and $spyRun.Out.Real)
    Assert-Test 'espions : aucune fonction espion hors de la portee qui les charge' ($null -eq (Get-Command -Name Read-Host -CommandType Function -ErrorAction SilentlyContinue))

    # --- Enchainement complet, deux modes -----------------------------------------------------------------------------
    Write-Section 'Enchainement complet : mode lu, pre-controles, sante, ticket, decision (deux modes)'
    $chainDir = Join-Path $Work 'chaine'
    New-Item -ItemType Directory -Path $chainDir | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $chainDir 'docker-compose.yml'), "services: {}`n")
    $chainEnv = Join-Path $chainDir '.env'
    $chainPorts = Start-TestServer @{ certDir = $certDir; envFile = $chainEnv; listeners = @(@{ name = 'https'; kind = 'https'; cert = 'A' }, @{ name = 'http'; kind = 'http' }) } @{}
    function Read-TestEnv([string]$Path) {
        $values = [ordered]@{}
        foreach ($line in [System.IO.File]::ReadAllLines($Path)) { if ($line -match '^\s*#' -or $line -notmatch '=') { continue }; $at = $line.IndexOf('='); $values[$line.Substring(0, $at).Trim()] = $line.Substring($at + 1).Trim() }
        return $values
    }
    foreach ($chain in @(@('https', $chainPorts.https, '', 'curl'), @('http', $chainPorts.http, '2026-09-15T10:32:00Z', 'native'))) {
        $scheme = $chain[0]
        [System.IO.File]::WriteAllText($chainEnv, ("COCKPIT_VERSION=1.0.5`nCOCKPIT_PORT={0}`nCOCKPIT_TOKEN={1}`nCOCKPIT_LOCAL_SCHEME={2}`nCOCKPIT_LOCAL_HTTP_CONFIRMED={3}`n" -f $chain[1], $Token, $scheme, $chain[2]))
        Set-DockerScenario ($healthyRules + @((New-CatRule 'cockpit.crt' 'A.crt'), (New-CatRule 'cockpit-tls.json' 'A.json')))
        # Variable du shell contraire a .env : masquee pour docker, sans effet sur le mode lu (K1-1).
        Set-Env 'COCKPIT_LOCAL_SCHEME' $(if ($scheme -ceq 'https') { 'http' } else { 'https' })
        $outcome = Invoke-WithSpies { Set-SpyPolicy -Hive HKLM -Name SSLErrorOverrideAllowed -Value 0 } {
            $run = Invoke-Captured {
                $config = Read-TestEnv $chainEnv
                $mode = Get-CockpitLocalMode $config
                $transition = Get-CockpitTransition -Mode $mode -IsNew $false -IsMigration $false
                $port = [int]$config['COCKPIT_PORT']
                $policy = Get-CockpitBrowserTlsPolicy -Port $port
                $prechecks = Get-CockpitPrecheckProblems -Transition $transition -Mode $mode -Policy $policy -AcceptBrowserBlock $false -IsMigration $false -LoadProblem '' -Port $port -Version '1.0.5' -PreviousVersion ''
                foreach ($warning in @($prechecks.Warnings)) { Write-CockpitLines $warning.Lines }
                if ($mode.Scheme -ceq 'http') { Write-CockpitModeNotice $mode $policy -OneLine }
                $health = Wait-CockpitHealth -Root $chainDir -Port $port -Mode $mode -Token $config['COCKPIT_TOKEN'] -TimeoutSec 60 -PollSec 1
                $login = Get-CockpitLoginUrl -Health $health -Port $port -Mode $mode -Token $config['COCKPIT_TOKEN']
                $decision = Get-CockpitOpenDecision -Health $health -Mode $mode -Policy $policy
                Write-CockpitLines $decision.Lines
                if ($decision.Decision -ceq 'Open' -and $login.Url) { Start-Process $login.Url }
                [pscustomobject]@{ Transition = $transition; Problems = @($prechecks.Problems).Count; Health = $health; Login = $login; Decision = $decision.Decision }
            }
            [pscustomobject]@{ Run = $run; Opened = @($SpyState.StartProcessCalls) }
        }
        Set-Env 'COCKPIT_LOCAL_SCHEME' $SavedEnv['COCKPIT_LOCAL_SCHEME']
        $value = $null
        if ($outcome.Run.Values.Count -gt 0) { $value = $outcome.Run.Values[0] }
        $label = 'enchainement ' + $scheme
        Assert-Test ($label + ' : aucune exception, transition Reste, aucun probleme bloquant') ($null -eq $outcome.Run.Error -and $null -ne $value -and $value.Transition -ceq ('Reste' + (Get-Culture).TextInfo.ToTitleCase($scheme)) -and $value.Problems -eq 0) $outcome.Run.Error
        Assert-Test ($label + ' : sante Ok par la voie attendue') ($null -ne $value -and $value.Health.Reason -ceq 'Ok' -and $value.Health.Method -ceq $chain[3]) $(if ($null -ne $value) { $value.Health.Reason + ' ' + $value.Health.Detail })
        Assert-Test ($label + ' : une seule ouverture, URL ticket du bon schema') ($outcome.Opened.Count -eq 1 -and [string]$outcome.Opened[0].FilePath -cmatch ('^' + $scheme + '://127\.0\.0\.1:' + $chain[1] + '/auth\?k=[0-9a-f]{64}\.[0-9a-f]{64}$'))
        Assert-Test ($label + ' : jeton et URL absents de la sortie') (-not $outcome.Run.Host.Contains($Token) -and ($outcome.Opened.Count -eq 0 -or -not $outcome.Run.Host.Contains([string]$outcome.Opened[0].FilePath)))
        if ($scheme -ceq 'https') { Assert-Test ($label + ' : A2-Reste puis A2-Open') ($outcome.Run.Host.Contains('Votre cockpit est deja en HTTPS') -and $outcome.Run.Host.Contains("Le lien s'ouvre quand meme")) }
        else { Assert-Test ($label + ' : A6-1, sans A2-Open') ($outcome.Run.Host.Contains('[!] Mode HTTP local (confirme le 2026-09-15 10:32 UTC)') -and -not $outcome.Run.Host.Contains("Le lien s'ouvre quand meme")) }
        $journal = @(Get-DockerJournal)
        Assert-Test ($label + ' : docker appele avec -f et sans variable du shell') ($journal.Count -gt 0 -and @($journal | Where-Object { @($_.env).Count -gt 0 -or ($_.args[0] -ceq 'compose' -and $_.args[1] -cne '-f') }).Count -eq 0)
    }
} finally {
    foreach ($server in $Servers) {
        try { $server.StandardInput.Close() } catch { }
        if (-not $server.WaitForExit(3000)) { try { $server.Kill() } catch { } }
    }
    foreach ($name in @($SavedEnv.Keys)) { [Environment]::SetEnvironmentVariable($name, $SavedEnv[$name], 'Process') }
    if (Microsoft.PowerShell.Management\Test-Path -LiteralPath $TestRegistryRoot) { Remove-Item -LiteralPath $TestRegistryRoot -Recurse -Force }
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host ('Test-CockpitTls : {0} reussi(s), {1} echec(s)' -f $Results.Pass, $Results.Fail)
Write-Host ('Nettoyage : dossier temporaire supprime={0}, cle de registre de test absente={1}' -f (-not (Test-Path -LiteralPath $Work)), (-not (Test-Path -LiteralPath $TestRegistryRoot)))
if ($Results.Fail -gt 0) { foreach ($failure in $Results.Failures) { Write-Host ('  - ' + $failure) }; exit 1 }
exit 0
