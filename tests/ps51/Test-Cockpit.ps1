# Test-Cockpit.ps1 - tests de cockpit.ps1 sous Windows PowerShell 5.1 (plan v2, lot 7). Sans Pester.
# Usage : powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/ps51/Test-Cockpit.ps1 [-FailFast]
# Banc partage : certificats (New-TestCerts.ps1), srv-test.mjs, faux docker, espions (tests/ps51/README.md).
# Aides propres au lot : tests/ps51/cockpit/ (installations jetables, faux install.ps1, depots git reels et jetables).
# Aucun secret reel : jeton aleatoire propre a l'execution, jamais affiche. Aucune ressource Docker, jamais le port 7777.
param([switch]$FailFast)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Here = $PSScriptRoot
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $Here '..\..'))
. (Join-Path $RepoRoot 'CockpitTls.ps1')
. (Join-Path $Here 'cockpit\Helpers.ps1')

$Results = @{ Pass = 0; Fail = 0; Failures = (New-Object System.Collections.Generic.List[string]) }
function Assert-Test([string]$Name, [bool]$Condition, [string]$Detail = '') {
    if ($Condition) { $Results.Pass++; return }
    $Results.Fail++
    $Results.Failures.Add(($Name + ' ' + $Detail).Trim())
    Write-Host ('  [KO] {0} {1}' -f $Name, $Detail) -ForegroundColor Red
    if ($FailFast) { throw ('FailFast : ' + $Name) }
}
function Write-Section([string]$Title) { Write-Host ('--- ' + $Title) -ForegroundColor Cyan }
function Get-Extract([string]$Text, [int]$Length = 220) {
    $flat = ([string]$Text -replace '\s+', ' ').Trim()
    if ($flat.Length -le $Length) { return $flat }
    return $flat.Substring(0, $Length)
}

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ('cockpit-l7-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Work | Out-Null
$EnvNames = @('PATH', 'COCKPIT_TEST_DOCKER_SCENARIO', 'COCKPIT_TEST_INSTALL_LOG', 'COCKPIT_LOCAL_SCHEME', 'COCKPIT_LOCAL_HTTP_CONFIRMED',
    'COCKPIT_TOKEN', 'COCKPIT_PORT', 'WORKSPACE_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY')
$SavedEnv = @{}
foreach ($name in $EnvNames) { $SavedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$Servers = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$Node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source

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

try {
    # --- Banc -----------------------------------------------------------------------------------------------------------
    Write-Section 'Banc : certificats, serveur de test, faux docker, installations jetables'
    $certDir = Join-Path $Work 'certs'
    $Certs = @{}
    foreach ($cert in @(& (Join-Path $Here 'New-TestCerts.ps1') -Directory $certDir -Names A, B)) { $Certs[$cert.Name] = $cert }
    $Token = New-CockpitChallenge
    $BehaviorFile = Join-Path $Work 'behavior.json'
    function Set-Behavior([hashtable]$Values) { [System.IO.File]::WriteAllText($BehaviorFile, (ConvertTo-Json -Depth 4 $Values)) }
    Set-Behavior @{ A = @{}; B = @{}; plain = @{} }
    $Ports = Start-TestServer @{ certDir = $certDir; behaviorFile = $BehaviorFile; listeners = @(
            @{ name = 'A'; kind = 'https'; cert = 'A' }, @{ name = 'B'; kind = 'https'; cert = 'B' }, @{ name = 'plain'; kind = 'http' }) } @{ SRV_TEST_TOKEN = $Token }
    Assert-Test 'banc : aucun port 7777' (@($Ports.PSObject.Properties | Where-Object { $_.Value -eq 7777 }).Count -eq 0)
    $StateA = ConvertTo-CockpitTlsState $Certs['A'].PemText $Certs['A'].JsonText
    $StateB = ConvertTo-CockpitTlsState $Certs['B'].PemText $Certs['B'].JsonText
    $CrtA = Join-Path $Work 'public-A.crt'; [System.IO.File]::WriteAllText($CrtA, $Certs['A'].PemText)
    $JsonA = Join-Path $Work 'public-A.json'; [System.IO.File]::WriteAllText($JsonA, $Certs['A'].JsonText)
    $CrtB = Join-Path $Work 'public-B.crt'; [System.IO.File]::WriteAllText($CrtB, $Certs['B'].PemText)
    $JsonB = Join-Path $Work 'public-B.json'; [System.IO.File]::WriteAllText($JsonB, $Certs['B'].JsonText)
    Initialize-DockerBench $Work
    Set-CockpitTestEnv 'PATH' ((Join-Path $Here 'fake-docker') + ';' + $SavedEnv['PATH'])
    $InstallLog = Join-Path $Work 'install-calls.jsonl'
    Set-CockpitTestEnv 'COCKPIT_TEST_INSTALL_LOG' $InstallLog
    function Get-InstallCalls {
        if (-not (Test-Path -LiteralPath $InstallLog)) { return @() }
        return @(Get-Content -LiteralPath $InstallLog | Where-Object { $_ })
    }
    $Workspace = Join-Path $Work 'projets'
    New-Item -ItemType Directory -Path $Workspace | Out-Null
    $ConfirmedAt = '2026-09-15T10:32:00Z'
    function New-TestEnvValues([int]$Port, [string]$Scheme, [string]$Confirmed = '', [string]$InstalledVersion = '1.0.5', [string]$InstallMode = 'Pull', $More) {
        $values = [ordered]@{ COCKPIT_PORT = $Port; COCKPIT_TOKEN = $Token; COCKPIT_LOCAL_SCHEME = $Scheme; COCKPIT_LOCAL_HTTP_CONFIRMED = $Confirmed
            COCKPIT_APP_IMAGE = 'opencode-cockpit/app:rg105-l7'; COCKPIT_OPENCODE_IMAGE = 'opencode-cockpit/opencode:rg105-l7'
            COCKPIT_INSTALL_MODE = $InstallMode; COCKPIT_VERSION = $InstalledVersion; WORKSPACE_DIR = $Workspace }
        if ($null -ne $More) { foreach ($key in @($More.Keys)) { $values[$key] = $More[$key] } }
        return $values
    }
    $HttpsDir = New-TestInstallation $Work 'https' (New-TestEnvValues $Ports.A 'https')
    $HttpDir = New-TestInstallation $Work 'http' (New-TestEnvValues $Ports.plain 'http' $ConfirmedAt)
    $PinDir = New-TestInstallation $Work 'pin' (New-TestEnvValues $Ports.B 'https')
    $BadDir = New-TestInstallation $Work 'invalide' (New-TestEnvValues $Ports.plain 'http')
    Assert-Test 'banc : installations jetables creees' ((Test-Path -LiteralPath (Join-Path $HttpsDir 'cockpit.ps1')) -and (Test-Path -LiteralPath (Join-Path $HttpDir 'install.ps1')))

    # --- open en HTTPS ----------------------------------------------------------------------------------------------
    Write-Section 'open en HTTPS'
    $UrlHttps = '^https://127\.0\.0\.1:{0}/auth\?k=[0-9a-f]{{64}}\.[0-9a-f]{{64}}\z' -f $Ports.A
    Set-DockerScenario (New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA)
    $open = Invoke-CockpitScript $HttpsDir @('open')
    Assert-Test 'open HTTPS : une seule ouverture' ($open.Opened.Count -eq 1) (Get-Extract $open.Host)
    Assert-Test 'open HTTPS : lien a usage unique (ticket), jamais le jeton' ($open.Opened.Count -eq 1 -and $open.Opened[0] -cmatch $UrlHttps -and -not $open.Opened[0].Contains($Token))
    Assert-Test 'open HTTPS : empreinte affichee avant l ouverture' ($open.Host.Contains('Empreinte SHA-256 du certificat : ' + $StateA.Sha256))
    Assert-Test 'open HTTPS : ni jeton ni ticket dans la sortie' (-not $open.Host.Contains($Token) -and -not ($open.Host -cmatch '/auth\?k='))
    Assert-Test 'open HTTPS : aucun avertissement de strategie sans strategie lue' (-not $open.Host.Contains('Strategie Edge lue'))

    Set-DockerScenario (New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA)
    $blocked = Invoke-CockpitScript $HttpsDir @('open') { Set-SpyPolicy -Hive HKLM -Browser Edge -Name SSLErrorOverrideAllowed -Value 0 -Origins @('https://127.0.0.1:1') }
    Assert-Test 'open HTTPS + Bloque : le lien s ouvre quand meme (K2-1)' ($blocked.Opened.Count -eq 1) (Get-Extract $blocked.Host)
    Assert-Test 'open HTTPS + Bloque : A2-Open affiche' ($blocked.Host.Contains("Strategie Edge lue : passage de l'avertissement interdit") -and $blocked.Host.Contains("Le lien s'ouvre quand meme"))

    Set-DockerScenario (New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA)
    $pin = Invoke-CockpitScript $PinDir @('open')
    Assert-Test 'open HTTPS : empreinte differente, aucune ouverture (A4)' ($pin.Opened.Count -eq 0 -and $pin.Host.Contains('ne presente PAS le certificat du cockpit') -and $pin.Host.Contains('Attendue : ' + $StateA.Sha256)) (Get-Extract $pin.Host)
    Assert-Test 'open HTTPS : A4 nomme le programme a l ecoute' ($pin.Host -cmatch 'Programme a l ecoute sur ce port : \S')

    Set-Behavior @{ A = @{ proof = 'bad' } }
    Set-DockerScenario (New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA)
    $badProof = Invoke-CockpitScript $HttpsDir @('open')
    Assert-Test 'open HTTPS : preuve fausse, aucune ouverture (A4-Preuve)' ($badProof.Opened.Count -eq 0 -and $badProof.Host.Contains('ne prouve pas qu il connait le jeton')) (Get-Extract $badProof.Host)

    Set-Behavior @{ A = @{ proof = 'null' } }
    Set-DockerScenario (New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA)
    $noFormat = Invoke-CockpitScript $HttpsDir @('open')
    Assert-Test 'open HTTPS : preuve non servie, jeton hors format (A4-Format)' ($noFormat.Opened.Count -eq 0 -and $noFormat.Host.Contains("n'a pas le format genere par install.ps1")) (Get-Extract $noFormat.Host)

    Set-Behavior @{ A = @{}; B = @{}; plain = @{} }

    # --- open en mode HTTP local ------------------------------------------------------------------------------------
    Write-Section 'open en mode HTTP local'
    Set-DockerScenario (New-CockpitDockerRules -Served 'http')
    $openHttp = Invoke-CockpitScript $HttpDir @('open')
    $urlHttp = '^http://127\.0\.0\.1:{0}/auth\?k=[0-9a-f]{{64}}\.[0-9a-f]{{64}}\z' -f $Ports.plain
    Assert-Test 'open HTTP : A6-1 affiche avant la verification' ($openHttp.Host.Contains('[!] Mode HTTP local (confirme le 2026-09-15 10:32 UTC) : trafic en clair sur ce PC')) (Get-Extract $openHttp.Host)
    Assert-Test 'open HTTP : une ouverture en http, lien a usage unique' ($openHttp.Opened.Count -eq 1 -and $openHttp.Opened[0] -cmatch $urlHttp -and -not $openHttp.Opened[0].Contains($Token))
    Assert-Test 'open HTTP : preuve du jeton annoncee, voie native' ($openHttp.Host.Contains('preuve du jeton verifiee : HttpWebRequest'))

    Set-Behavior @{ plain = @{ scheme = 'https' } }
    Set-DockerScenario (New-CockpitDockerRules -Served 'https')
    $diverge = Invoke-CockpitScript $HttpDir @('open') { Set-CockpitTestEnv 'COCKPIT_LOCAL_SCHEME' 'MARQUEUR-VALEUR-L7' }
    Set-CockpitTestEnv 'COCKPIT_LOCAL_SCHEME' $SavedEnv['COCKPIT_LOCAL_SCHEME']
    Assert-Test 'open HTTP : schema different, aucune ouverture (A11)' ($diverge.Opened.Count -eq 0 -and $diverge.Host.Contains('ne sert pas le mode inscrit dans .env (.env : http ; cockpit : https)')) (Get-Extract $diverge.Host)
    Assert-Test 'open HTTP : A11 nomme la variable, jamais sa valeur' ($diverge.Host.Contains('Cause trouvee : variable(s) COCKPIT_LOCAL_SCHEME definie(s) (Processus)') -and -not $diverge.Host.Contains('MARQUEUR'))
    Assert-Test 'open HTTP : A11 donne le remede' ($diverge.Host.Contains('Appliquer .env : .\cockpit.ps1 restart'))
    Set-Behavior @{ A = @{}; B = @{}; plain = @{} }

    # --- Etat intermediaire : scripts 1.0.5, conteneurs 1.0.4 (K2-3) ------------------------------------------------
    Write-Section 'K2-3 : mise a jour inachevee (image du conteneur cockpit anterieure a 1.0.5)'
    Set-DockerScenario ((New-CockpitDockerRules -ImageVersion '1.0.4' -CrtFile $CrtA -JsonFile $JsonA) + @((New-Rule '^compose -f \S.* exec -T cockpit cat ' '' 0 $null '' -Fail)))
    $old = Invoke-CockpitScript $HttpsDir @('open')
    Assert-Test 'K2-3 A10 : aucune ouverture' ($old.Opened.Count -eq 0) (Get-Extract $old.Host)
    Assert-Test 'K2-3 A10 : le cockpit en place fonctionne toujours, adresse de base donnee' ($old.Host.Contains('Mise a jour inachevee : les scripts sont en 1.0.5, le cockpit en marche est en 1.0.4') -and $old.Host.Contains(('Votre cockpit 1.0.4 fonctionne toujours sur http://127.0.0.1:{0}' -f $Ports.A)))
    Assert-Test 'K2-3 A10 : issues de reconnexion et de sortie' ($old.Host.Contains('utilisez votre favori') -and $old.Host.Contains('.\cockpit.ps1 rollback') -and $old.Host.Contains('Terminer la mise a jour : .\install.ps1'))
    Assert-Test 'K2-3 A10 : jamais de saisie du jeton proposee (K1-4)' (-not $old.Host.Contains('COCKPIT_TOKEN'))
    Assert-Test 'K2-3 : aucune verification tentee sur un cockpit 1.0.4' (-not (Test-DockerCall 'exec -T cockpit cat'))

    Set-DockerScenario (New-CockpitDockerRules -ImageVersion '1.0.4')
    $startOld = Invoke-CockpitScript $HttpsDir @('start')
    Assert-Test 'etat intermediaire : start avertit (A10-court) puis demarre' ($startOld.Host.Contains('Mise a jour inachevee (scripts 1.0.5, cockpit 1.0.4)') -and (Test-DockerCall '^compose -f \S.* up -d --pull never --no-build\z')) (Get-Extract $startOld.Host)

    # Conteneur recree par le compose 1.0.5 : printenv rend https, mais l'image 1.0.4 ignore la variable et sert en HTTP.
    Set-DockerScenario ((New-CockpitDockerRules -ImageVersion '1.0.4' -Served 'https') + @((New-Rule '.*' '' 0)))
    $diagOld = Invoke-CockpitScript $HttpsDir @('diag')
    Assert-Test 'K2-3 diag : mode servi exact pour un cockpit 1.0.4 (http, mode d acces non gere)' ($diagOld.Host.Contains('Mode (cockpit)  : http (cockpit 1.0.4 anterieur a 1.0.5, mode d acces non gere)')) (Get-Extract ($diagOld.Host.Substring([Math]::Max(0, $diagOld.Host.IndexOf('Mode (.env)')))))
    Assert-Test 'K2-3 diag : ni "https" ni "illisible (conteneur arrete ?)" pour le mode servi' (-not $diagOld.Host.Contains('Mode (cockpit)  : https') -and -not $diagOld.Host.Contains('Mode (cockpit)  : illisible') -and -not $diagOld.Host.Contains('different de .env'))
    Assert-Test 'K2-3 diag : A10 affiche une seule fois' ([regex]::Matches($diagOld.Host, [regex]::Escape('Mise a jour inachevee : les scripts sont en 1.0.5')).Count -eq 1)
    Assert-Test 'K2-3 diag : aucun printenv dans un conteneur 1.0.4' (-not (Test-DockerCall 'exec -T cockpit printenv'))

    # --- Mode invalide dans .env (A18) ------------------------------------------------------------------------------
    Write-Section 'A18 : mode d acces invalide dans .env'
    foreach ($command in @('open', 'start', 'restart')) {
        Set-DockerScenario @((New-Rule '^compose -f \S.* up' '' 0 $null '' -Fail), (New-Rule '.*' '' 0))
        $invalid = Invoke-CockpitScript $BadDir @($command)
        Assert-Test ('A18 sur {0} : message et arret' -f $command) ($invalid.Host.Contains("[!] Mode d'acces invalide dans .env : COCKPIT_LOCAL_SCHEME=http sans date de confirmation valable.") -and $invalid.Host.Contains('.\install.ps1 -Https (recommande)')) (Get-Extract $invalid.Host)
        Assert-Test ('A18 sur {0} : aucun compose up' -f $command) (-not (Test-DockerCall ' up'))
        if ($command -ceq 'open') { Assert-Test 'A18 sur open : aucune ouverture' ($invalid.Opened.Count -eq 0) }
    }

    # --- status et diag ---------------------------------------------------------------------------------------------
    Write-Section 'status et diag dans les deux modes'
    Set-DockerScenario (New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA)
    $status = Invoke-CockpitScript $HttpsDir @('status')
    Assert-Test 'status HTTPS : adresse, empreinte, echeance et voie' ($status.Host -cmatch ('Cockpit : disponible sur https://127\.0\.0\.1:{0} \(empreinte {1}, expire dans [0-9]+ jours, voie curl\)' -f $Ports.A, [regex]::Escape($StateA.Sha256))) (Get-Extract $status.Host)
    Assert-Test 'status HTTPS : aucun jeton dans la sortie' (-not $status.Host.Contains($Token))

    Set-DockerScenario (New-CockpitDockerRules -Served 'http')
    $statusHttp = Invoke-CockpitScript $HttpDir @('status')
    Assert-Test 'status HTTP : A6-1 puis adresse et preuve du jeton' ($statusHttp.Host.Contains('[!] Mode HTTP local (confirme le') -and $statusHttp.Host -cmatch ('Cockpit : disponible sur http://127\.0\.0\.1:{0} \(preuve du jeton verifiee, voie HttpWebRequest\)' -f $Ports.plain)) (Get-Extract $statusHttp.Host)

    # Resumes reels du serveur (TlsRefusals.flush, app/server/tls.ts) : message accentue, totaux par fenetre de 60 s.
    $refusedMessage = '"msg":"connexions TLS refus' + [char]0xE9 + 'es sur la boucle locale"'
    $tlsSummary = { param([string]$At, [int]$Total, [string]$Codes) ('cockpit-1  | {{"t":"2026-09-15T10:{0}.000Z","level":"info",{1},"total":{2},"codes":{{{3}}}}}' -f $At, $refusedMessage, $Total, $Codes) }
    $tlsJournal = ((@((& $tlsSummary '00:00' 15 '"ERR_SSL_HTTP_REQUEST":15'),
                'cockpit-1  | {"t":"2026-09-15T10:00:30.000Z","level":"info","msg":"cockpit a l ecoute","total":99}',
                'cockpit-1  | tlsClientError code=SSL_ERR',
                (& $tlsSummary '01:00' 25 '"AUTRE":3,"ERR_SSL_HTTP_REQUEST":22')) -join "`n") + "`n")
    Set-DockerScenario ((New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA -Served 'http' -Extra @((New-Rule '^compose -f \S.* logs --since 30m cockpit$' $tlsJournal))) + @((New-Rule '.*' '' 0)))
    $diag = Invoke-CockpitScript $HttpsDir @('diag') { Set-CockpitTestEnv 'COCKPIT_TOKEN' 'MARQUEUR-VALEUR-DIAG' }
    Set-CockpitTestEnv 'COCKPIT_TOKEN' $SavedEnv['COCKPIT_TOKEN']
    Assert-Test 'diag : section Acces a l interface' ($diag.Host.Contains('--- Acces a l interface ---') -and $diag.Host.Contains('Mode (.env)     : https')) (Get-Extract $diag.Host)
    Assert-Test 'K1-1 diag : schema servi different, variable nommee sans sa valeur' ($diag.Host.Contains('Mode (cockpit)  : http - different de .env') -and $diag.Host.Contains('Cause : variable(s) COCKPIT_TOKEN definie(s) (Processus)') -and -not $diag.Host.Contains('MARQUEUR'))
    Assert-Test 'diag : certificat servi et refus TLS additionnes depuis les resumes du serveur (30 min)' ($diag.Host.Contains('Certificat      : ' + $StateA.Sha256) -and $diag.Host.Contains('Refus TLS       : 40 connexion(s) refusee(s) sur 30 min (2 resume(s) du journal')) (Get-Extract ($diag.Host.Substring([Math]::Max(0, $diag.Host.IndexOf('Refus TLS')))))
    Assert-Test 'diag : journal lu sur 30 minutes (plan 3.9)' ((Test-DockerCall '^compose -f \S.* logs --since 30m cockpit\z') -and -not (Test-DockerCall 'logs --tail 200 cockpit'))
    Assert-Test 'diag : strategie Edge absente nommee, jamais une valeur vide' ($diag.Host.Contains('Edge            : SSLErrorOverrideAllowed = absente (aucune), verdict Autorise') -and -not $diag.Host.Contains('SSLErrorOverrideAllowed =  ('))

    $noSummary = ((@('cockpit-1  | {"t":"2026-09-15T10:00:30.000Z","level":"info","msg":"cockpit a l ecoute","total":99}', 'cockpit-1  | tlsClientError code=SSL_ERR') -join "`n") + "`n")
    Set-DockerScenario ((New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA -Extra @((New-Rule '^compose -f \S.* logs --since 30m cockpit$' $noSummary))) + @((New-Rule '.*' '' 0)))
    $diagQuiet = Invoke-CockpitScript $HttpsDir @('diag')
    Assert-Test 'diag : aucune ligne de resume, aucun refus compte' ($diagQuiet.Host.Contains('Refus TLS       : 0 connexion(s) refusee(s) sur 30 min (0 resume(s) du journal')) (Get-Extract ($diagQuiet.Host.Substring([Math]::Max(0, $diagQuiet.Host.IndexOf('Refus TLS')))))
    Assert-Test 'diag : voie de verification et LanguageMode' ($diag.Host -cmatch 'Voie qui serait utilisee : (curl \(|classe \.NET)' -and $diag.Host.Contains('LanguageMode FullLanguage'))
    Assert-Test 'J2-10 diag : aucun verdict "Edge interdit" sans strategie, malgre 40 refus TLS' (-not $diag.Host.Contains('Edge interdit')) (Get-Extract $diag.Host)
    Assert-Test 'diag : aucun jeton dans la sortie' (-not $diag.Host.Contains($Token))

    Set-DockerScenario ((New-CockpitDockerRules -Served 'http') + @((New-Rule '.*' '' 0)))
    $diagHttp = Invoke-CockpitScript $HttpDir @('diag')
    Assert-Test 'diag HTTP : mode date et certificat non utilise' ($diagHttp.Host.Contains('Mode (.env)     : http, confirme le 2026-09-15T10:32:00Z UTC') -and $diagHttp.Host.Contains('Certificat      : non utilise (mode HTTP local)')) (Get-Extract $diagHttp.Host)
    Assert-Test 'diag HTTP : verdict A6b quand Edge semble autoriser HTTPS' ($diagHttp.Host.Contains('le mode HTTPS est probablement utilisable'))

    # 1.0.6 : opencode ne sort que par le relais du cockpit. Code du CONNECT (relais=...) : 403 = refus sur place, 502 = permis mais
    # refuse en amont. Journal du cockpit : une ligne par hote et par heure (message reel de egress-relay.ts, accents compris).
    $relayLine = { param([string]$Hote) ('cockpit-1  | {{"t":"2026-09-24T08:00:00.000Z","level":"warn","msg":"sortie d{0}opencode refus{1}e par le relais du cockpit (refus local, rien n{0}est envoy{1} au proxy de l{0}entreprise)","hote":"{2}","port":443,"raison":"hote","refus":1}}' -f "'", [char]0xE9, $Hote) }
    $relayJournal = ((@((& $relayLine 'registry.npmjs.org'), 'cockpit-1  | {"t":"2026-09-24T08:00:01.000Z","level":"info","msg":"cockpit a l ecoute"}',
                (& $relayLine 'models.opencode.ai'), (& $relayLine 'models.opencode.ai')) -join "`n") + "`n")
    $ocCurl = '^exec rg105-l7-opencode-1 curl .* https://{0}/\z'
    $relayRules = @(
        (New-Rule ($ocCurl -f 'api\.githubcopilot\.com') "x-github-request-id: A1`ncode=404 relais=200"),
        (New-Rule ($ocCurl -f 'api\.enterprise\.githubcopilot\.com') 'code=000 relais=502'),
        (New-Rule ($ocCurl -f 'models\.opencode\.ai') 'code=000 relais=403'),
        (New-Rule ($ocCurl -f 'registry\.npmjs\.org') 'code=000 relais=403'),
        (New-Rule '^compose -f \S.* logs --no-color --since 24h cockpit\z' $relayJournal))
    Set-DockerScenario ((New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA -Extra $relayRules) + @((New-Rule '.*' '' 0)))
    $diagRelay = Invoke-CockpitScript $HttpsDir @('diag')
    $relayPart = $diagRelay.Host.Substring([Math]::Max(0, $diagRelay.Host.IndexOf('--- Acces reseau depuis le conteneur opencode')))
    Assert-Test '1.0.6 diag : titre de la section reseau (seule sortie : le relais du cockpit)' ($diagRelay.Host.Contains('--- Acces reseau depuis le conteneur opencode (seule sortie : le relais du cockpit')) (Get-Extract $relayPart)
    Assert-Test '1.0.6 diag : hote Copilot relaye et joignable' ($relayPart -cmatch 'api\.githubcopilot\.com +404  joignable') (Get-Extract $relayPart)
    Assert-Test '1.0.6 diag : hote hors liste bloque sur place, rien envoye au proxy' ($relayPart -cmatch 'models\.opencode\.ai +000  bloque sur place par le relais du cockpit' -and $relayPart -cmatch 'registry\.npmjs\.org +000  bloque sur place') (Get-Extract $relayPart)
    Assert-Test '1.0.6 diag : hote permis mais refuse en amont' ($relayPart -cmatch 'api\.enterprise\.githubcopilot\.com +000  permis par le relais, mais refuse ou injoignable en amont') (Get-Extract $relayPart)
    Assert-Test '1.0.6 diag : refus du relais lus dans le journal du cockpit (hotes uniques, tries)' ($relayPart.Contains('Relais (24 h)   : 3 ligne(s) de refus, hotes bloques sur place : models.opencode.ai, registry.npmjs.org')) (Get-Extract $relayPart)
    Set-DockerScenario ((New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA) + @((New-Rule '.*' '' 0)))
    $diagNoRelay = Invoke-CockpitScript $HttpsDir @('diag')
    Assert-Test '1.0.6 diag : aucun refus du relais journalise' ($diagNoRelay.Host.Contains('Relais (24 h)   : aucun refus journalise'))

    Set-DockerScenario ((New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA) + @((New-Rule '.*' '' 0)))
    $diagBlocked = Invoke-CockpitScript $HttpsDir @('diag') { Set-SpyPolicy -Hive HKCU -Browser Edge -Name SSLErrorOverrideAllowed -Value 0 }
    Assert-Test 'J2-10 diag : verdict Edge interdit avec la strategie lue Bloque' ($diagBlocked.Host.Contains('Verdict : Edge interdit de passer l avertissement de certificat pour https://127.0.0.1:' + $Ports.A)) (Get-Extract $diagBlocked.Host)

    # Plan 3.11 : sans curl.exe, diag ne lance aucun Add-Type (voie seulement annoncee) ; status, lui, passe par la classe .NET
    # en dernier recours (plan 3.7.2). Ordre impose : diag d'abord, le type compile ne se decharge plus du processus.
    $SystemCurl = Join-Path ([Environment]::GetFolderPath('System')) 'curl.exe'
    Assert-Test 'banc : classe .NET pas encore compilee dans ce processus' ($null -eq ('OpencodeCockpit.PinnedHttp' -as [type]))
    Set-DockerScenario ((New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA) + @((New-Rule '.*' '' 0)))
    $diagNoCurl = Invoke-CockpitScript $HttpsDir @('diag') { Hide-SpyPath $SystemCurl }
    Assert-Test 'plan 3.11 diag sans curl.exe : aucun Add-Type (classe .NET absente du processus, aucun A8)' ($null -eq ('OpencodeCockpit.PinnedHttp' -as [type]) -and -not $diagNoCurl.Host.Contains('Voie de secours : petite classe .NET')) (Get-Extract $diagNoCurl.Host)
    Assert-Test 'plan 3.11 diag sans curl.exe : sante non verifiee, renvoi vers status' ($diagNoCurl.Host.Contains('Sante           : non verifiee par diag (curl.exe : absent). diag ne lance aucune compilation ; verification par la classe .NET : .\cockpit.ps1 status')) (Get-Extract ($diagNoCurl.Host.Substring([Math]::Max(0, $diagNoCurl.Host.IndexOf('Sante')))))
    Assert-Test 'plan 3.11 diag sans curl.exe : voie qui serait utilisee et verdict' ($diagNoCurl.Host.Contains('curl.exe        : inutilisable (absent)') -and $diagNoCurl.Host.Contains('Voie qui serait utilisee : classe .NET (compilation, alerte antivirus possible)') -and $diagNoCurl.Host.Contains('Verdict : interface non verifiee par diag (curl.exe inutilisable, aucune compilation ici) : .\cockpit.ps1 status')) (Get-Extract ($diagNoCurl.Host.Substring([Math]::Max(0, $diagNoCurl.Host.IndexOf('curl.exe')))))
    Assert-Test 'plan 3.11 diag sans curl.exe : certificat servi toujours affiche' ($diagNoCurl.Host.Contains('Certificat      : ' + $StateA.Sha256))

    Set-DockerScenario (New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA)
    $statusNoCurl = Invoke-CockpitScript $HttpsDir @('status') { Hide-SpyPath $SystemCurl }
    Assert-Test 'plan 3.7.2 status sans curl.exe : classe .NET en dernier recours, A8 une fois' ($statusNoCurl.Host -cmatch ('Cockpit : disponible sur https://127\.0\.0\.1:{0} \(empreinte {1}, expire dans [0-9]+ jours, voie classe \.NET\)' -f $Ports.A, [regex]::Escape($StateA.Sha256)) -and [regex]::Matches($statusNoCurl.Host, [regex]::Escape('Verification HTTPS : curl.exe indisponible (absent).')).Count -eq 1) (Get-Extract $statusNoCurl.Host)

    # --- tls et tls -Renew ------------------------------------------------------------------------------------------
    Write-Section 'tls et tls -Renew'
    Set-DockerScenario (New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA)
    $tls = Invoke-CockpitScript $HttpsDir @('tls')
    Assert-Test 'tls HTTPS : empreinte, cle publique, validite et verification' ($tls.Host.Contains('Empreinte SHA-256 : ' + $StateA.Sha256) -and $tls.Host.Contains('Cle publique      : sha256//' + $StateA.SpkiBase64) -and $tls.Host.Contains('Cockpit verifie sur')) (Get-Extract $tls.Host)
    Assert-Test 'tls HTTPS : strategie Edge absente nommee, jamais une valeur vide' ($tls.Host.Contains('Strategie Edge lue : SSLErrorOverrideAllowed = absente, verdict Autorise') -and -not $tls.Host.Contains('SSLErrorOverrideAllowed = ,'))

    Set-DockerScenario (New-CockpitDockerRules -Served 'http')
    $tlsHttp = Invoke-CockpitScript $HttpDir @('tls')
    Assert-Test 'A16 : tls en mode HTTP' ($tlsHttp.Host.Contains("Mode HTTP local : aucun certificat n'est servi") -and $tlsHttp.Host.Contains("n'est ni lu ni modifie par le cockpit")) (Get-Extract $tlsHttp.Host)
    Assert-Test 'A16 : strategie Edge absente nommee, jamais une valeur vide' ($tlsHttp.Host.Contains('Strategie Edge lue : SSLErrorOverrideAllowed = absente, verdict Autorise') -and -not $tlsHttp.Host.Contains('SSLErrorOverrideAllowed = ,'))

    Set-DockerScenario (New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA -Extra @((New-Rule '^compose -f \S.* stop' '' 0 $null '' -Fail), (New-Rule '^run ' '' 0 $null '' -Fail)))
    $noRenew = Invoke-CockpitScript $HttpsDir @('tls') -Parameters @{ Renew = $true } { Add-SpyReadHostAnswer 'renouveler' }
    Assert-Test 'tls -Renew : reponse autre que RENOUVELER, aucun appel docker de modification' ($noRenew.Host.Contains('Annule.') -and @($noRenew.Prompts | Where-Object { $_ -ceq 'Tapez RENOUVELER pour confirmer' }).Count -eq 1 -and @(Get-DockerJournal | Where-Object { $_.forbidden }).Count -eq 0) (Get-Extract $noRenew.Host)

    # Certificat A publie avant le renouvellement, B apres : le cockpit de test sert B (nouvelle empreinte epinglee).
    $PinRenewRules = @((New-Rule '^compose -f \S.* exec -T cockpit cat /tls/public/cockpit\.crt$' '' 0 1 $CrtA),
        (New-Rule '^compose -f \S.* exec -T cockpit cat /tls/public/cockpit-tls\.json$' '' 0 1 $JsonA))
    Set-DockerScenario (New-CockpitDockerRules -CrtFile $CrtB -JsonFile $JsonB -Extra $PinRenewRules)
    $renew = Invoke-CockpitScript $PinDir @('tls') -Parameters @{ Renew = $true } { Add-SpyReadHostAnswer 'RENOUVELER' }
    Assert-Test 'tls -Renew HTTPS : arret, suppression de la cle et des certificats, redemarrage' ((Test-DockerCall '^compose -f \S.* stop cockpit\z') -and (Test-DockerCall '^compose -f \S.* up -d --pull never --no-build cockpit\z') -and (Test-DockerCall '^run --rm --pull never --network none --user 1000:1000 --entrypoint rm -v rg105-l7_cockpit-tls:/tls \S+ -f /tls/private/cockpit\.key /tls/private/cockpit\.crt /tls/public/cockpit\.crt\z')) (Get-Extract $renew.Host)
    Assert-Test 'RG5 tls -Renew HTTPS : cockpit-tls.json garde (le serveur y lit previousSha256)' (-not (Test-DockerCall '^run .*cockpit-tls\.json')) (Get-Extract $renew.Host)
    Assert-Test 'tls -Renew HTTPS : ancienne puis nouvelle empreinte' ($renew.Host.Contains(('ancienne empreinte {0} -> nouvelle {1}' -f $StateA.Sha256, $StateB.Sha256))) (Get-Extract $renew.Host)

    Set-DockerScenario (New-CockpitDockerRules -Served 'http' -Extra @((New-Rule '^compose -f \S.* stop' '' 0 $null '' -Fail), (New-Rule '^compose -f \S.* up' '' 0 $null '' -Fail)))
    $renewHttp = Invoke-CockpitScript $HttpDir @('tls') -Parameters @{ Renew = $true } { Add-SpyReadHostAnswer 'RENOUVELER' }
    Assert-Test 'A17 : tls -Renew en HTTP, suppression sans arret ni redemarrage' ((Test-DockerCall '^run --rm --pull never --network none') -and @(Get-DockerJournal | Where-Object { $_.forbidden }).Count -eq 0 -and $renewHttp.Host.Contains('Certificat local efface (volume cockpit-tls).')) (Get-Extract $renewHttp.Host)
    Assert-Test 'RG5 tls -Renew HTTP : meme suppression, cockpit-tls.json garde' ((Test-DockerCall '-f /tls/private/cockpit\.key /tls/private/cockpit\.crt /tls/public/cockpit\.crt\z') -and -not (Test-DockerCall '^run .*cockpit-tls\.json'))

    # --- update -----------------------------------------------------------------------------------------------------
    Write-Section 'update : git pull --ff-only par Invoke-CockpitProcess, puis install.ps1 -NoBrowser'
    $upd = New-TestGitInstallation $Work 'update' (New-TestEnvValues $Ports.plain 'http' $ConfirmedAt)
    Add-TestUpstreamCommit $Work $upd.Origin $upd.Branch 'nouveau.txt'
    $before = @(Get-InstallCalls).Count
    Set-DockerScenario @((New-Rule '.*' '' 0))
    $update = Invoke-CockpitScript $upd.Directory @('update')
    $calls = @(Get-InstallCalls)
    Assert-Test 'update : le commit publie en amont est ramene (git pull --ff-only)' (Test-Path -LiteralPath (Join-Path $upd.Directory 'nouveau.txt')) (Get-Extract $update.Host)
    Assert-Test 'update : install.ps1 relance avec -NoBrowser, sans -Http ni -Https (I2)' ($calls.Count -eq $before + 1 -and $calls[$calls.Count - 1] -ceq '["-NoBrowser"]') ($calls -join ' ')
    Assert-Test 'update : aucune exception malgre les lignes de git sur stderr (P5)' ($null -eq $update.Error) ([string]$update.Error)

    $noGit = New-TestInstallation $Work 'update-sans-git' (New-TestEnvValues $Ports.plain 'http' $ConfirmedAt)
    $before = @(Get-InstallCalls).Count
    $updateNoGit = Invoke-CockpitScript $noGit @('update')
    Assert-Test 'update sans .git : consignes avec CockpitTls.ps1, install.ps1 non relance' ($updateNoGit.Host.Contains('Unblock-File .\install.ps1, .\cockpit.ps1, .\CockpitTls.ps1') -and @(Get-InstallCalls).Count -eq $before) (Get-Extract $updateNoGit.Host)

    # --- K1-1 : variables du shell et fichier override ---------------------------------------------------------------
    Write-Section 'K1-1 : variables du shell et docker-compose.override.yml'
    [System.IO.File]::WriteAllText((Join-Path $HttpsDir 'docker-compose.override.yml'), "services: {}`n", (New-Object System.Text.UTF8Encoding $false))
    Set-CockpitTestEnv 'COCKPIT_LOCAL_SCHEME' 'http'
    Set-CockpitTestEnv 'COCKPIT_LOCAL_HTTP_CONFIRMED' $ConfirmedAt
    Set-CockpitTestEnv 'COCKPIT_TOKEN' 'MARQUEUR-JETON-SHELL'
    Set-CockpitTestEnv 'WORKSPACE_DIR' 'C:\ailleurs'
    Set-CockpitTestEnv 'HTTP_PROXY' 'http://127.0.0.1:9'
    Set-DockerScenario (New-CockpitDockerRules -CrtFile $CrtA -JsonFile $JsonA)
    $isolated = Invoke-CockpitScript $HttpsDir @('status')
    $journal = Get-DockerJournal
    $leaks = @($journal | Where-Object { @($_.env).Count -gt 0 })
    $composeCalls = @($journal | Where-Object { @($_.args)[0] -ceq 'compose' })
    $withFile = @($composeCalls | Where-Object { @($_.args)[1] -ceq '-f' -and @($_.args)[2] -ceq (Join-Path $HttpsDir 'docker-compose.yml') })
    Assert-Test 'K1-1 : aucune variable de compose dans l environnement du faux docker' ($leaks.Count -eq 0) (($leaks | ForEach-Object { @($_.env) -join ',' }) -join ' | ')
    Assert-Test 'K1-1 : chaque commande compose recoit -f <dossier>\docker-compose.yml' ($composeCalls.Count -gt 0 -and $withFile.Count -eq $composeCalls.Count) ('{0}/{1}' -f $withFile.Count, $composeCalls.Count)
    Assert-Test 'I2 : le mode servi reste celui de .env malgre la variable et l override' ($isolated.Host -cmatch 'Cockpit : disponible sur https://' -and -not $isolated.Host.Contains('MARQUEUR')) (Get-Extract $isolated.Host)
    Assert-Test 'K1-1 : variables du processus restaurees apres le script' (([Environment]::GetEnvironmentVariable('COCKPIT_TOKEN', 'Process') -ceq 'MARQUEUR-JETON-SHELL') -and ([Environment]::GetEnvironmentVariable('HTTP_PROXY', 'Process') -ceq 'http://127.0.0.1:9'))
    foreach ($name in @('COCKPIT_LOCAL_SCHEME', 'COCKPIT_LOCAL_HTTP_CONFIRMED', 'COCKPIT_TOKEN', 'WORKSPACE_DIR', 'HTTP_PROXY')) { Set-CockpitTestEnv $name $SavedEnv[$name] }
    Remove-Item -LiteralPath (Join-Path $HttpsDir 'docker-compose.override.yml') -Force

    # --- Messages sans voie de verification (A9, A9-HTTP) -----------------------------------------------------------
    Write-Section 'A9 et A9-HTTP : aucune voie de verification utilisable'
    function Test-CockpitInternalMessages([string]$Directory, $TlsState, [int]$Port) {
        # cockpit.ps1 charge par dot-sourcing : la commande 'logs invalide' leve avant tout appel docker, apres la
        # definition des fonctions. Seul moyen d'observer les messages d'une voie indisponible sans crochet dans le produit.
        try { . (Join-Path $Directory 'cockpit.ps1') logs invalide } catch { }
        $noWay = [pscustomobject]@{ Reason = 'AucuneVoie'; Method = ''; Status = 0; Version = ''; Ticket = ''; Retry = $false; ContainerHealth = ''
            Detail = 'curl.exe : absent ; classe .NET : compilation refusee'; TlsState = $TlsState }
        $https = Invoke-Captured { Write-CockpitHealthProblem $noWay ([pscustomobject]@{ Scheme = 'https'; ConfirmedAt = $null; Raw = $null; Valid = $true; Problem = $null }) $Port }
        $http = Invoke-Captured { Write-CockpitHealthProblem $noWay ([pscustomobject]@{ Scheme = 'http'; ConfirmedAt = '2026-09-15T10:32:00Z'; Raw = 'http'; Valid = $true; Problem = $null }) $Port }
        $a10 = Invoke-Captured { Write-CockpitA10 $null $Port }
        return [pscustomobject]@{ Https = $https.Host; Http = $http.Host; A10 = $a10.Host }
    }
    $messages = Test-CockpitInternalMessages $HttpsDir $StateA $Ports.A
    Assert-Test 'A9 : raison des voies, verification manuelle et empreinte' ($messages.Https.Contains('Aucune voie de verification utilisable (curl.exe : absent ; classe .NET : compilation refusee)') -and $messages.Https.Contains('comparez son empreinte SHA-256 a : ' + $StateA.Sha256) -and $messages.Https.Contains('Aucune page n')) (Get-Extract $messages.Https)
    Assert-Test 'A9 : saisie proposee seulement en HTTPS' ($messages.Https.Contains('la valeur de COCKPIT_TOKEN'))
    Assert-Test 'K1-4 A9-HTTP : jamais de saisie du jeton dans une page' ($messages.Http.Contains('le jeton ne se saisit jamais dans une page') -and -not $messages.Http.Contains('COCKPIT_TOKEN') -and $messages.Http.Contains('.\cockpit.ps1 diag')) (Get-Extract $messages.Http)
    Assert-Test 'A10 : version d image illisible annoncee comme anterieure a 1.0.5' ($messages.A10.Contains('le cockpit en marche est en anterieure a 1.0.5'))

    # --- rollback ----------------------------------------------------------------------------------------------------
    Write-Section 'rollback : cible, controles R1 a R8, plan, execution'
    $PreviousKeys = @{ COCKPIT_PREVIOUS_VERSION = '1.0.4'; COCKPIT_PREVIOUS_APP_IMAGE = 'opencode-cockpit/app:1.0.4'
        COCKPIT_PREVIOUS_OPENCODE_IMAGE = 'opencode-cockpit/opencode:1.0.4'; COCKPIT_PREVIOUS_INSTALL_MODE = 'Pull' }
    Set-DockerScenario @((New-Rule '.*' '' 0))

    $full = New-TestGitInstallation $Work 'rb-complet' (New-TestEnvValues $Ports.plain 'http' $ConfirmedAt '1.0.5' 'Pull' $PreviousKeys)
    New-Item -ItemType Directory -Path (Join-Path $full.Directory 'testinstall') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $full.Directory 'testinstall\trace.txt'), "banc`n")
    $before = @(Get-InstallCalls).Count
    $rollback = Invoke-CockpitScript $full.Directory @('rollback') { Add-SpyReadHostAnswer 'REVENIR' }
    $calls = @(Get-InstallCalls)
    $headFull = Get-TestGitOut $full.Directory @('rev-parse', 'HEAD')
    $tagFull = Get-TestGitOut $full.Directory @('rev-parse', 'v1.0.4^{commit}')
    Assert-Test 'rollback : depot propre avec testinstall/ non suivi, retour autorise' ($rollback.Host.Contains('Version 1.0.4 retablie')) (Get-Extract $rollback.Host)
    Assert-Test 'rollback : A13 annonce le plan et ce qui est conserve' ($rollback.Host.Contains('==> Retour a la version 1.0.4') -and $rollback.Host.Contains('git checkout --no-overwrite-ignore -B principal v1.0.4') -and $rollback.Host.Contains('Conserves : volume cockpit-tls'))
    Assert-Test 'K1-2 rollback : A13 dit que la cible sert en HTTP en clair sans verification' ($rollback.Host.Contains('est servie en HTTP, en clair, sans bandeau') -and $rollback.Host.Contains('remplacera ce jeton'))
    Assert-Test 'rollback (pre-publication 1.1.0) : A13 dit que la cible n a pas le relais de la 1.0.6' ($rollback.Host.Contains('[!] La version 1.0.4 n a pas le relais de la 1.0.6') -and $rollback.Host.Contains('repartiront vers le proxy de l entreprise')) (Get-Extract $rollback.Host)
    Assert-Test 'rollback : branche repositionnee sur l etiquette' ($headFull -ceq $tagFull -and (Get-TestGitOut $full.Directory @('symbolic-ref', '--short', 'HEAD')) -ceq 'principal')
    Assert-Test 'rollback : suivi distant conserve' ((Get-TestGitOut $full.Directory @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')) -ceq 'origin/principal')
    Assert-Test 'I12 rollback : 4 cles remplacees dans .env' ((Get-TestEnvValue $full.Directory 'COCKPIT_APP_IMAGE') -ceq 'opencode-cockpit/app:1.0.4' -and (Get-TestEnvValue $full.Directory 'COCKPIT_OPENCODE_IMAGE') -ceq 'opencode-cockpit/opencode:1.0.4' -and (Get-TestEnvValue $full.Directory 'COCKPIT_INSTALL_MODE') -ceq 'Pull' -and (Get-TestEnvValue $full.Directory 'COCKPIT_VERSION') -ceq '1.0.4')
    Assert-Test 'I12 rollback : mode d acces, date et jeton conserves' ((Get-TestEnvValue $full.Directory 'COCKPIT_LOCAL_SCHEME') -ceq 'http' -and (Get-TestEnvValue $full.Directory 'COCKPIT_LOCAL_HTTP_CONFIRMED') -ceq $ConfirmedAt -and (Get-TestEnvValue $full.Directory 'COCKPIT_TOKEN') -ceq $Token)
    Assert-Test 'rollback : install.ps1 de la cible relance avec -NoBrowser' ($calls.Count -eq $before + 1 -and $calls[$calls.Count - 1] -ceq '["-NoBrowser"]')
    Assert-Test 'rollback Pull : A13 et A13-fin promettent le retour par update' ($rollback.Host.Contains('.\cockpit.ps1 update ramenera ensuite la derniere version') -and $rollback.Host.Contains('.\cockpit.ps1 update ramenera la 1.0.5 dans le mode d acces memorise (HTTP local).') -and -not $rollback.Host.Contains('-ImagesArchive'))

    # Mode Load : update s'arreterait sur les images 1.0.4 de .env (A-Load, M5) ; A13 et A13-fin donnent la vraie marche a suivre.
    $loadPrevious = @{} + $PreviousKeys
    $loadPrevious['COCKPIT_PREVIOUS_INSTALL_MODE'] = 'Load'
    $loadFull = New-TestGitInstallation $Work 'rb-load-complet' (New-TestEnvValues $Ports.plain 'http' $ConfirmedAt '1.0.5' 'Load' $loadPrevious)
    $before = @(Get-InstallCalls).Count
    $loadRollback = Invoke-CockpitScript $loadFull.Directory @('rollback') { Add-SpyReadHostAnswer 'REVENIR' }
    $calls = @(Get-InstallCalls)
    Assert-Test 'rollback Load : retour complet mene a bien' ($loadRollback.Host.Contains('Version 1.0.4 retablie') -and $calls.Count -eq $before + 1 -and (Get-TestEnvValue $loadFull.Directory 'COCKPIT_VERSION') -ceq '1.0.4') (Get-Extract $loadRollback.Host)
    Assert-Test 'rollback Load : A13-fin sans la promesse "update ramenera"' (-not $loadRollback.Host.Contains('update ramenera')) (Get-Extract ($loadRollback.Host.Substring([Math]::Max(0, $loadRollback.Host.IndexOf('retablie')))))
    Assert-Test 'rollback Load : A13-fin annonce l arret de update et donne la commande -ImagesArchive' ($loadRollback.Host.Contains('Mode Load : .\cockpit.ps1 update s arretera (images 1.0.4 inscrites dans .env).') -and $loadRollback.Host.Contains('.\cockpit.ps1 update, puis .\install.ps1 -Mode Load -ImagesArchive <opencode-cockpit-images-1.0.5.tar.gz>') -and $loadRollback.Host.Contains('d acces memorise (HTTP local)'))
    Assert-Test 'rollback Load : A13 annonce l archive d images' ($loadRollback.Host.Contains('mode Load : revenir ensuite a la 1.0.5 demandera son archive d images'))

    $scripts = New-TestGitInstallation $Work 'rb-scripts' (New-TestEnvValues $Ports.plain 'http' $ConfirmedAt '1.0.4')
    $before = @(Get-InstallCalls).Count
    $envBefore = Get-TestFileHash (Join-Path $scripts.Directory '.env')
    $onlyScripts = Invoke-CockpitScript $scripts.Directory @('rollback') { Add-SpyReadHostAnswer 'REVENIR' }
    Assert-Test 'rollback scripts seuls : conteneurs inchanges, install.ps1 non relance' ($onlyScripts.Host.Contains("Vos conteneurs 1.0.4 n ont pas change.") -and @(Get-InstallCalls).Count -eq $before) (Get-Extract $onlyScripts.Host)
    Assert-Test 'rollback scripts seuls : aucune commande absente des scripts 1.0.4 retablis (-Http)' (-not $onlyScripts.Host.Contains('.\install.ps1 -Http') -and -not $onlyScripts.Host.Contains('.\install.ps1 (HTTPS)')) (Get-Extract ($onlyScripts.Host.Substring([Math]::Max(0, $onlyScripts.Host.IndexOf('[OK] Scripts')))))
    Assert-Test 'rollback scripts seuls : terminer la mise a jour par update' ($onlyScripts.Host.Contains('Terminer la mise a jour plus tard : .\cockpit.ps1 update (ramene les scripts 1.0.5'))
    Assert-Test 'rollback scripts seuls : .env inchange et branche repositionnee' ((Get-TestFileHash (Join-Path $scripts.Directory '.env')) -ceq $envBefore -and (Get-TestGitOut $scripts.Directory @('rev-parse', 'HEAD')) -ceq (Get-TestGitOut $scripts.Directory @('rev-parse', 'v1.0.4^{commit}')))

    $dirty = New-TestGitInstallation $Work 'rb-modifie' (New-TestEnvValues $Ports.plain 'https' '' '1.0.5' 'Pull' $PreviousKeys)
    [System.IO.File]::WriteAllText((Join-Path $dirty.Directory 'VERSION'), "1.0.5-modifie`n")
    $headBefore = Get-TestGitOut $dirty.Directory @('rev-parse', 'HEAD')
    $dirtyResult = Invoke-CockpitScript $dirty.Directory @('rollback')
    Assert-Test 'A15-b : fichier suivi modifie, aucune commande git d ecriture' ($dirtyResult.Host.Contains('Retour impossible : 1 fichier(s) suivi(s) modifie(s) : VERSION') -and $dirtyResult.Prompts.Count -eq 0 -and (Get-TestGitOut $dirty.Directory @('rev-parse', 'HEAD')) -ceq $headBefore) (Get-Extract $dirtyResult.Host)

    $ahead = New-TestGitInstallation $Work 'rb-commit-local' (New-TestEnvValues $Ports.plain 'https' '' '1.0.5' 'Pull' $PreviousKeys)
    [System.IO.File]::WriteAllText((Join-Path $ahead.Directory 'local.txt'), "travail local`n")
    Invoke-TestGit $ahead.Directory @('add', '-A') | Out-Null
    Invoke-TestGit $ahead.Directory @('commit', '-q', '-m', 'travail local') | Out-Null
    $aheadResult = Invoke-CockpitScript $ahead.Directory @('rollback')
    Assert-Test 'A15-d : commit local non publie' ($aheadResult.Host.Contains('Retour impossible : 1 commit(s) local(aux) non publie(s) sur principal') -and $aheadResult.Prompts.Count -eq 0) (Get-Extract $aheadResult.Host)

    $noRemote = New-TestGitInstallation $Work 'rb-sans-suivi' (New-TestEnvValues $Ports.plain 'https' '' '1.0.5' 'Pull' $PreviousKeys) -NoUpstream
    $noRemoteResult = Invoke-CockpitScript $noRemote.Directory @('rollback')
    Assert-Test 'A15-c : aucune branche de suivi distant' ($noRemoteResult.Host.Contains("Retour impossible : la branche principal n a pas de suivi distant")) (Get-Extract $noRemoteResult.Host)

    $detached = New-TestGitInstallation $Work 'rb-detache' (New-TestEnvValues $Ports.plain 'https' '' '1.0.5' 'Pull' $PreviousKeys) -Detached
    $detachedResult = Invoke-CockpitScript $detached.Directory @('rollback')
    Assert-Test 'A15-a : HEAD detache' ($detachedResult.Host.Contains('Retour impossible : HEAD git detache (aucune branche).')) (Get-Extract $detachedResult.Host)

    $noTag = New-TestGitInstallation $Work 'rb-sans-etiquette' (New-TestEnvValues $Ports.plain 'https' '' '1.0.5' 'Pull' $PreviousKeys) -NoTag
    $noTagResult = Invoke-CockpitScript $noTag.Directory @('rollback')
    Assert-Test 'A15-e : etiquette absente, aucun fetch' ($noTagResult.Host.Contains('Retour impossible : etiquette v1.0.4 absente.') -and (Get-TestGitOut $noTag.Directory @('tag', '-l')) -ceq '') (Get-Extract $noTagResult.Host)

    $offBranch = New-TestGitInstallation $Work 'rb-hors-lignee' (New-TestEnvValues $Ports.plain 'https' '' '1.0.5' 'Pull' $PreviousKeys) -TagOffBranch
    $offBranchResult = Invoke-CockpitScript $offBranch.Directory @('rollback')
    Assert-Test 'A15-f : etiquette hors de la lignee de la branche' ($offBranchResult.Host.Contains("Retour impossible : v1.0.4 n est pas une version anterieure de la branche principal.")) (Get-Extract $offBranchResult.Host)

    $refused = New-TestGitInstallation $Work 'rb-refus' (New-TestEnvValues $Ports.plain 'https' '' '1.0.5' 'Pull' $PreviousKeys)
    $headBefore = Get-TestGitOut $refused.Directory @('rev-parse', 'HEAD')
    $envBefore = Get-TestFileHash (Join-Path $refused.Directory '.env')
    $refusedResult = Invoke-CockpitScript $refused.Directory @('rollback') { Add-SpyReadHostAnswer 'revenir' }
    Assert-Test 'rollback : reponse autre que REVENIR, rien n est modifie' ($refusedResult.Host.Contains('Annule.') -and (Get-TestGitOut $refused.Directory @('rev-parse', 'HEAD')) -ceq $headBefore -and (Get-TestFileHash (Join-Path $refused.Directory '.env')) -ceq $envBefore) (Get-Extract $refusedResult.Host)

    $conflict = New-TestGitInstallation $Work 'rb-conflit' (New-TestEnvValues $Ports.plain 'https' '' '1.0.5' 'Pull' $PreviousKeys) -RemovedInHead 'ancien.txt'
    [System.IO.File]::WriteAllText((Join-Path $conflict.Directory 'ancien.txt'), "fichier local non suivi`n")
    $headBefore = Get-TestGitOut $conflict.Directory @('rev-parse', 'HEAD')
    $conflictResult = Invoke-CockpitScript $conflict.Directory @('rollback') { Add-SpyReadHostAnswer 'REVENIR' }
    Assert-Test 'A15-h : conflit avec un fichier non suivi, HEAD et .env inchanges' ($conflictResult.Host.Contains('git a refuse de changer de version') -and (Get-TestGitOut $conflict.Directory @('rev-parse', 'HEAD')) -ceq $headBefore -and (Get-TestEnvValue $conflict.Directory 'COCKPIT_VERSION') -ceq '1.0.5') (Get-Extract $conflictResult.Host)

    $ignored = New-TestGitInstallation $Work 'rb-ignore' (New-TestEnvValues $Ports.plain 'https' '' '1.0.5' 'Pull' $PreviousKeys) -IgnoredByHead 'journal.txt'
    [System.IO.File]::WriteAllText((Join-Path $ignored.Directory 'journal.txt'), "travail local a ne pas ecraser`n")
    $digestBefore = Get-TestFileHash (Join-Path $ignored.Directory 'journal.txt')
    $headBefore = Get-TestGitOut $ignored.Directory @('rev-parse', 'HEAD')
    $ignoredResult = Invoke-CockpitScript $ignored.Directory @('rollback') { Add-SpyReadHostAnswer 'REVENIR' }
    Assert-Test 'K1-3 : fichier ignore ici mais suivi par la cible, git refuse (--no-overwrite-ignore)' ($ignoredResult.Host.Contains('git a refuse de changer de version')) (Get-Extract $ignoredResult.Host)
    Assert-Test 'K1-3 : contenu du fichier local intact (condense identique)' ((Get-TestFileHash (Join-Path $ignored.Directory 'journal.txt')) -ceq $digestBefore)
    Assert-Test 'K1-3 : HEAD et .env inchanges' ((Get-TestGitOut $ignored.Directory @('rev-parse', 'HEAD')) -ceq $headBefore -and (Get-TestEnvValue $ignored.Directory 'COCKPIT_VERSION') -ceq '1.0.5')

    $loadKeys = @{} + $PreviousKeys
    $load = New-TestGitInstallation $Work 'rb-load' (New-TestEnvValues $Ports.plain 'https' '' '1.0.5' 'Load' $loadKeys)
    $headBefore = Get-TestGitOut $load.Directory @('rev-parse', 'HEAD')
    Set-DockerScenario @((New-Rule '^image inspect --format \{\{\.Id\}\} ' '' 1))
    $loadResult = Invoke-CockpitScript $load.Directory @('rollback')
    Assert-Test 'A15-g : mode Load, image de la cible absente, avant tout git' ($loadResult.Host.Contains('Retour impossible (mode Load) : image opencode-cockpit/app:1.0.4 absente.') -and $loadResult.Prompts.Count -eq 0 -and (Get-TestGitOut $load.Directory @('rev-parse', 'HEAD')) -ceq $headBefore) (Get-Extract $loadResult.Host)
    Set-DockerScenario @((New-Rule '.*' '' 0))

    $zip = New-TestInstallation $Work 'rb-zip' (New-TestEnvValues $Ports.plain 'https' '' '1.0.5' 'Pull' $PreviousKeys)
    $before = @(Get-InstallCalls).Count
    $zipResult = Invoke-CockpitScript $zip @('rollback') { Add-SpyReadHostAnswer 'REVENIR' }
    Assert-Test 'A14 : sans git, retour complet, consignes apres REVENIR' ($zipResult.Host.Contains('Dossier sans git : remplacez les fichiers par ceux de la version 1.0.4.') -and $zipResult.Host.Contains('4. .\install.ps1 -NoBrowser, puis .\cockpit.ps1 open')) (Get-Extract $zipResult.Host)
    Assert-Test 'A14 : sans git, .env porte les 4 cles de la cible, install.ps1 non relance' ((Get-TestEnvValue $zip 'COCKPIT_VERSION') -ceq '1.0.4' -and (Get-TestEnvValue $zip 'COCKPIT_APP_IMAGE') -ceq 'opencode-cockpit/app:1.0.4' -and @(Get-InstallCalls).Count -eq $before)

    $zipScripts = New-TestInstallation $Work 'rb-zip-scripts' (New-TestEnvValues $Ports.plain 'https' '' '1.0.4')
    $envBefore = Get-TestFileHash (Join-Path $zipScripts '.env')
    $zipScriptsResult = Invoke-CockpitScript $zipScripts @('rollback') { Add-SpyReadHostAnswer 'REVENIR' }
    Assert-Test 'A14 : sans git, scripts seuls, aucune ligne install.ps1 et .env inchange' ($zipScriptsResult.Host.Contains('Dossier sans git') -and -not $zipScriptsResult.Host.Contains('install.ps1 -NoBrowser') -and (Get-TestFileHash (Join-Path $zipScripts '.env')) -ceq $envBefore) (Get-Extract $zipScriptsResult.Host)

    $noPrevious = New-TestInstallation $Work 'rb-sans-precedente' (New-TestEnvValues $Ports.plain 'https' '' '1.0.5')
    $noPreviousResult = Invoke-CockpitScript $noPrevious @('rollback')
    Assert-Test 'A15-a : aucune version precedente memorisee' ($noPreviousResult.Host.Contains('Retour impossible : aucune version precedente memorisee dans .env (COCKPIT_PREVIOUS_VERSION).')) (Get-Extract $noPreviousResult.Host)

    # --- Sauvegarde, restauration et desinstallation, salle comprise (decision du 17/09, point 3) ---------------------
    # Les chaines que le test P13 de la CI interdit dans les scripts qu'elle appelle sont assemblees, jamais ecrites.
    Write-Section 'Sauvegarde et desinstallation : la salle gardee, sauf -PurgeOmo'
    $NomVariableImageSalle = 'COCKPIT_OMO' + '_IMAGE'
    $ImageSalle = 'exemple/salle:essai'
    $Contrat = ConvertFrom-Json ([System.IO.File]::ReadAllText((Join-Path $CockpitRepoRoot ('docker\opencode' + '-omo\contrat-salle.json'))))
    $VolumesSalle = @($Contrat.volumes | ForEach-Object { [string]$_.nom })
    # Volumes nommes du fichier compose, moins ceux du contrat : ceux du cockpit, quels qu'ils soient au moment du test.
    $VolumesCompose = New-Object System.Collections.Generic.List[string]
    $dansVolumes = $false
    foreach ($ligne in [System.IO.File]::ReadAllLines((Join-Path $CockpitRepoRoot 'docker-compose.yml'))) {
        if ($ligne -cmatch '^volumes:\s*\z') { $dansVolumes = $true; continue }
        if ($dansVolumes -and $ligne -cmatch '^[^\s#]') { $dansVolumes = $false }
        if ($dansVolumes -and $ligne -cmatch '^  ([a-z0-9][a-z0-9_-]*):\s*\z') { $VolumesCompose.Add($Matches[1]) }
    }
    $VolumesCockpit = @($VolumesCompose.ToArray() | Where-Object { $VolumesSalle -cnotcontains $_ })
    Assert-Test 'banc : volumes du cockpit lus dans docker-compose.yml' ($VolumesCockpit.Count -ge 6) ($VolumesCockpit -join ', ')
    Assert-Test 'contrat : volumes de la salle nommes' ($VolumesSalle.Count -ge 6 -and $VolumesSalle -ccontains 'oc-omo-data' -and $VolumesSalle -ccontains 'omo-config')

    $SalleKeys = @{ COCKPIT_OMO = 'on'; OPENCODE_OMO_PASSWORD = (New-CockpitChallenge) }
    $SalleKeys[$NomVariableImageSalle] = $ImageSalle
    $SalleDir = New-TestInstallation $Work 'salle' (New-TestEnvValues $Ports.plain 'https' '' '1.0.5' 'Pull' $SalleKeys)
    $ArchivesDir = Join-Path $Work 'salle-archives'
    New-Item -ItemType Directory -Path $ArchivesDir -Force | Out-Null
    # Forme reelle depuis la 1.0.6 (HTTP_PROXY et http_proxy d'un meme service) : backup et restore la lisent (repetition generale F2).
    $ConfigJson = New-FakeComposeConfigJson 'rg105-l7' $ArchivesDir
    function Set-SalleScenario {
        Set-DockerScenario (New-CockpitDockerRules -Extra @((New-Rule '^compose -f \S.* config --format json$' $ConfigJson),
                (New-Rule '^volume rm -f ' "supprimes`n"), (New-Rule '^image rm -f ' "supprimees`n"), (New-Rule '^compose -f \S.* down\b' '')))
    }

    Set-SalleScenario
    $backupResult = Invoke-CockpitScript $SalleDir @('backup')
    # --pull never (fiche MW 1.2) : l'image du cockpit n'est jamais tiree d'un registre par une sauvegarde.
    $tarCall = @(Get-DockerJournal | Where-Object { (@($_.args) -join ' ') -cmatch '^run --rm --pull never --entrypoint tar ' })
    $tarArgs = ''
    if ($tarCall.Count -gt 0) { $tarArgs = (@($tarCall[0].args) -join ' ') }
    Assert-Test 'backup : les conversations de la salle sont montees en lecture seule' ($tarArgs -cmatch 'rg105-l7_oc-omo-data:/src/oc-omo-data:ro') (Get-Extract $tarArgs)
    Assert-Test 'backup : auth.json de la salle exclu' ($tarArgs.Contains('--exclude=oc-omo-data/auth.json')) (Get-Extract $tarArgs)
    Assert-Test 'backup : auth.json de l instance principale exclu' ($tarArgs.Contains('--exclude=oc-data/auth.json'))
    Assert-Test 'backup : certificat local jamais sauvegarde' (-not $tarArgs.Contains('cockpit-tls'))
    Assert-Test 'backup : rien de omo-config n est sauvegarde (recalcule a chaque demarrage)' (-not $tarArgs.Contains('omo-config'))
    Assert-Test 'backup : message qui nomme les exclusions' ($backupResult.Host.Contains('celui de la salle compris')) (Get-Extract $backupResult.Host)

    Set-SalleScenario
    $purgeResult = Invoke-CockpitScript $SalleDir @('uninstall') { Add-SpyReadHostAnswer 'SUPPRIMER' } @{ Purge = $true }
    $volumeCall = @(Get-DockerJournal | Where-Object { (@($_.args) -join ' ') -cmatch '^volume rm -f ' })
    $volumeArgs = ''
    if ($volumeCall.Count -gt 0) { $volumeArgs = (@($volumeCall[0].args) -join ' ') }
    $imageCall = @(Get-DockerJournal | Where-Object { (@($_.args) -join ' ') -cmatch '^image rm -f ' })
    $imageArgs = ''
    if ($imageCall.Count -gt 0) { $imageArgs = (@($imageCall[0].args) -join ' ') }
    Assert-Test 'uninstall -Purge : conteneurs et reseau retires avec le profil de la salle' (Test-DockerCall '^compose -f \S.* --profile omo down --remove-orphans\z') (Get-Extract ((Get-DockerJournal | ForEach-Object { (@($_.args) -join ' ') }) -join ' | '))
    Assert-Test 'uninstall -Purge : volumes du cockpit supprimes' (@($VolumesCockpit | Where-Object { $volumeArgs.Contains('rg105-l7_' + $_) }).Count -eq $VolumesCockpit.Count) (Get-Extract $volumeArgs)
    Assert-Test 'uninstall -Purge : aucun volume de la salle supprime' (@($VolumesSalle | Where-Object { $volumeArgs.Contains('rg105-l7_' + $_) }).Count -eq 0) (Get-Extract $volumeArgs)
    Assert-Test 'uninstall -Purge : images du cockpit supprimees' ($imageArgs.Contains('opencode-cockpit/app:rg105-l7') -and $imageArgs.Contains('opencode-cockpit/opencode:rg105-l7')) (Get-Extract $imageArgs)
    Assert-Test 'uninstall -Purge : image de la salle gardee' (-not $imageArgs.Contains($ImageSalle)) (Get-Extract $imageArgs)
    Assert-Test 'uninstall -Purge : la conservation de la salle est annoncee' ($purgeResult.Host.Contains('Conserves : l image de la salle')) (Get-Extract $purgeResult.Host)

    Set-SalleScenario
    $purgeOmoResult = Invoke-CockpitScript $SalleDir @('uninstall') { Add-SpyReadHostAnswer 'SUPPRIMER' } @{ Purge = $true; PurgeOmo = $true }
    $volumeCall = @(Get-DockerJournal | Where-Object { (@($_.args) -join ' ') -cmatch '^volume rm -f ' })
    $volumeArgs = ''
    if ($volumeCall.Count -gt 0) { $volumeArgs = (@($volumeCall[0].args) -join ' ') }
    $imageCall = @(Get-DockerJournal | Where-Object { (@($_.args) -join ' ') -cmatch '^image rm -f ' })
    $imageArgs = ''
    if ($imageCall.Count -gt 0) { $imageArgs = (@($imageCall[0].args) -join ' ') }
    Assert-Test 'uninstall -PurgeOmo : volumes de la salle supprimes, configuration figee comprise' (@($VolumesSalle | Where-Object { $volumeArgs.Contains('rg105-l7_' + $_) }).Count -eq $VolumesSalle.Count -and $volumeArgs.Contains('rg105-l7_omo-config')) (Get-Extract $volumeArgs)
    Assert-Test 'uninstall -PurgeOmo : image de la salle supprimee' ($imageArgs.Contains($ImageSalle)) (Get-Extract $imageArgs)
    Assert-Test 'uninstall -PurgeOmo : avertissement sur l image a reconstruire' ($purgeOmoResult.Host.Contains('ET DE LA SALLE')) (Get-Extract $purgeOmoResult.Host)

    Set-SalleScenario
    $refusResult = Invoke-CockpitScript $SalleDir @('uninstall') $null @{ PurgeOmo = $true }
    Assert-Test 'uninstall : -PurgeOmo seul refuse, rien n est supprime' ($null -ne $refusResult.Error -and $refusResult.Error.Contains('-PurgeOmo ne s utilise qu avec -Purge') -and -not (Test-DockerCall '^volume rm ')) (Get-Extract $refusResult.Error)

    Set-SalleScenario
    $simpleResult = Invoke-CockpitScript $SalleDir @('uninstall')
    Assert-Test 'uninstall sans -Purge : les donnees restent' ($simpleResult.Host.Contains('Les donnees restent dans les volumes Docker') -and -not (Test-DockerCall '^volume rm ') -and -not (Test-DockerCall '^image rm ')) (Get-Extract $simpleResult.Host)

    # --- restore : migration du web de la sauvegarde restauree (decision A37, fiche MW 1.1 point 3 : T6 e) -------------------------
    # Apres l'extraction reussie, avant le redemarrage (finally : up -d --force-recreate) ; extraction en echec : aucun appel.
    Write-Section 'restore : regles Internet de la sauvegarde restauree (migration du web, A37)'
    $RestoreDir = New-TestInstallation $Work 'restore' (New-TestEnvValues $Ports.plain 'https')
    $BackupFile = Join-Path $Work 'cockpit-20260927-101500.tar.gz'
    [System.IO.File]::WriteAllText($BackupFile, 'archive factice du banc')
    $MigrationPattern = '^run --rm --pull never --name rg105-l7-migration-web-[0-9a-f]{8} --network none --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 -v rg105-l7_oc-config:/oc-config --entrypoint node opencode-cockpit/app:rg105-l7 --no-warnings server/migrate-oc-config.ts /oc-config\z'
    $ExtractPattern = '^run --rm --pull never --user 0 --entrypoint sh '
    function Get-JournalIndex([string]$Pattern) {
        $calls = @(Get-DockerJournal | ForEach-Object { (@($_.args) -join ' ') })
        for ($i = 0; $i -lt $calls.Count; $i++) { if ($calls[$i] -cmatch $Pattern) { return $i } }
        return -1
    }
    function Set-RestoreScenario([string]$Migration = 'migration-web etat=absent profil=- fichier=- blocs=0 restes=0 sauvegarde=- raison=-', [object[]]$More = @()) {
        Set-DockerScenario (New-CockpitDockerRules -Migration $Migration -Extra (@($More) + @((New-Rule '^compose -f \S.* config --format json$' $ConfigJson))))
    }
    $RestoreHeader = '==> Regles Internet de la sauvegarde restauree'

    Set-RestoreScenario 'migration-web etat=conforme profil=- fichier=opencode.jsonc blocs=0 restes=0 sauvegarde=- raison=-'
    $restore = Invoke-CockpitScript $RestoreDir @('restore', $BackupFile) { Add-SpyReadHostAnswer 'RESTAURER' }
    $extractAt = Get-JournalIndex $ExtractPattern
    $migrationAt = Get-JournalIndex $MigrationPattern
    $upAt = Get-JournalIndex '^compose -f \S.* up -d --force-recreate --pull never --no-build\z'
    Assert-Test 'restore : extraction (--pull never), puis migration, puis up -d --force-recreate' ($null -eq $restore.Error -and $extractAt -ge 0 -and $migrationAt -gt $extractAt -and $upAt -gt $migrationAt) ('{0},{1},{2} {3} {4}' -f $extractAt, $migrationAt, $upAt, $restore.Error, (Get-Extract (@(Get-DockerJournal | ForEach-Object { (@($_.args) -join ' ') }) -join ' | ') 600))
    Assert-Test 'restore : verification de l archive avec --pull never' ((Get-JournalIndex '^run --rm --pull never --entrypoint tar -v \S.*:/backup:ro opencode-cockpit/app:rg105-l7 tzf /backup/cockpit-20260927-101500\.tar\.gz\z') -ge 0) (Get-Extract (@(Get-DockerJournal | ForEach-Object { (@($_.args) -join ' ') }) -join ' | ') 600)
    Assert-Test 'restore : sauvegarde 1.1 (conforme) -> rien d affiche sur les regles Internet' (-not $restore.Host.Contains($RestoreHeader) -and $restore.Host.Contains('Restauration terminee.')) (Get-Extract $restore.Host)

    Set-RestoreScenario 'migration-web etat=migre profil=prudent fichier=opencode.jsonc blocs=1 restes=0 sauvegarde=opencode.jsonc.avant-1.1.0 raison=-'
    $restore = Invoke-CockpitScript $RestoreDir @('restore', $BackupFile) { Add-SpyReadHostAnswer 'RESTAURER' }
    $attendu = @($RestoreHeader, "    [OK] Profil de droits Prudent conserve : seul l'acces a Internet est desormais refuse.",
        "    C'etait deja impossible depuis la 1.0.6 (seul GitHub Copilot est joignable), et une demande restee sans reponse pouvait bloquer les autres autorisations.",
        "    Copie de l'ancien fichier : opencode.jsonc.avant-1.1.0, dans le volume de configuration d'opencode (compris dans .\cockpit.ps1 backup).") -join "`n"
    Assert-Test 'restore : sauvegarde 1.0.x re-migree, en-tete propre a la restauration' ($null -eq $restore.Error -and $restore.Host.Contains($attendu)) (Get-Extract $restore.Host 900)

    Set-RestoreScenario 'sortie sans rapport'
    $restore = Invoke-CockpitScript $RestoreDir @('restore', $BackupFile) { Add-SpyReadHostAnswer 'RESTAURER' }
    $rmAt = Get-JournalIndex '^rm -f rg105-l7-migration-web-[0-9a-f]{8}\z'
    $upAt = Get-JournalIndex '^compose -f \S.* up -d --force-recreate --pull never --no-build\z'
    Assert-Test 'restore : sortie inattendue -> [!], conteneur retire avant le redemarrage, restauration terminee' ($null -eq $restore.Error -and $restore.Host.Contains('[!] Regles Internet laissees telles quelles (verification impossible).') -and $rmAt -ge 0 -and $upAt -gt $rmAt) (Get-Extract $restore.Host 600)

    Set-RestoreScenario 'migration-web etat=migre profil=prudent fichier=opencode.jsonc blocs=1 restes=0 sauvegarde=opencode.jsonc.avant-1.1.0 raison=-' @((New-Rule $ExtractPattern '' 1))
    $restore = Invoke-CockpitScript $RestoreDir @('restore', $BackupFile) { Add-SpyReadHostAnswer 'RESTAURER' }
    Assert-Test 'restore : extraction en echec -> aucune migration, redemarrage quand meme' ($null -ne $restore.Error -and (Get-JournalIndex '^run --rm --pull never --name ') -lt 0 -and (Get-JournalIndex '^compose -f \S.* up -d --force-recreate --pull never --no-build\z') -ge 0 -and -not $restore.Host.Contains($RestoreHeader)) (Get-Extract (@(Get-DockerJournal | ForEach-Object { (@($_.args) -join ' ') }) -join ' | ') 600)

    # --- Relecture 2ter-vague-3 : une entree de premier niveau supprimee apres install.ps1 ne fait jamais demarrer la salle ----
    # Docker recreerait la source absente en DOSSIER vide sur le poste (un fichier devient un dossier) : cockpit.ps1 ne passe pas le
    # profil de la salle a la creation ni au demarrage des conteneurs, le dit, et le garde pour l'arret.
    Write-Section 'start et restart : la salle ne demarre pas quand une source de la surcharge manque'
    $SourcesDir = New-TestInstallation $Work 'salle-sources' (New-TestEnvValues $Ports.plain 'https' '' '1.0.5' 'Pull' $SalleKeys)
    $WsSources = Join-Path $Work 'ws-salle-sources'
    New-Item -ItemType Directory -Path (Join-Path $WsSources 'app\src') -Force | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $WsSources 'app\README.md'), "lisez-moi`n")
    $montage = { param([string]$Relatif, [string]$Forme) '      - { type: bind, source: "' + ((Join-Path $WsSources ($Relatif -replace '/', '\')) -replace '\\', '/') + '", target: "/workspace/' + $Relatif + '", bind: { create_host_path: false } } # ' + $Forme }
    $surcharge = "services:`n  cockpit:`n    volumes: []`n  " + ('opencode' + '-omo') + ":`n    volumes:`n" + (& $montage 'app/README.md' 'fichier') + "`n" + (& $montage 'app/src' 'dossier') + "`n"
    [System.IO.File]::WriteAllText((Join-Path $SourcesDir $CockpitOmoOverlay), $surcharge, (New-Object System.Text.UTF8Encoding $false))
    Set-DockerScenario (New-CockpitDockerRules)
    $temoinSources = Invoke-CockpitScript $SourcesDir @('start')
    Assert-Test 'start, sources presentes : la salle demarre avec son profil (temoin)' ((Test-DockerCall '^compose -f \S+ -f \S+ --profile omo up -d --pull never --no-build\z') -and -not $temoinSources.Host.Contains('Salle non demarree')) (Get-Extract ((Get-DockerJournal | ForEach-Object { (@($_.args) -join ' ') }) -join ' | '))
    Remove-Item -LiteralPath (Join-Path $WsSources 'app\README.md') -Force
    Set-DockerScenario (New-CockpitDockerRules)
    $sansSource = Invoke-CockpitScript $SourcesDir @('start')
    Assert-Test 'start, fichier supprime : up sans le profil de la salle' ((Test-DockerCall '^compose -f \S+ -f \S+ up -d --pull never --no-build\z') -and -not (Test-DockerCall '--profile omo up')) (Get-Extract ((Get-DockerJournal | ForEach-Object { (@($_.args) -join ' ') }) -join ' | '))
    Assert-Test 'start, fichier supprime : message qui nomme l entree et demande la relance d install.ps1' ($sansSource.Host.Contains('Salle non demarree') -and $sansSource.Host.Contains('app/README.md') -and $sansSource.Host.Contains('Relancez install.ps1')) (Get-Extract $sansSource.Host)
    Assert-Test 'start, fichier supprime : rien n est recree sur le poste' (-not (Test-Path -LiteralPath (Join-Path $WsSources 'app\README.md')))
    Set-DockerScenario (New-CockpitDockerRules)
    $recree = Invoke-CockpitScript $SourcesDir @('restart')
    Assert-Test 'restart, fichier supprime : recreation sans le profil de la salle' ((Test-DockerCall '^compose -f \S+ -f \S+ up -d --force-recreate --pull never --no-build\z') -and -not (Test-DockerCall '--profile omo up')) (Get-Extract ((Get-DockerJournal | ForEach-Object { (@($_.args) -join ' ') }) -join ' | '))
    Assert-Test 'restart, fichier supprime : message' ($recree.Host.Contains('Salle non demarree')) (Get-Extract $recree.Host)
    Set-DockerScenario (New-CockpitDockerRules)
    $arretSources = Invoke-CockpitScript $SourcesDir @('stop')
    Assert-Test 'stop, fichier supprime : profil garde, la salle s arrete aussi (MO-3)' ((Test-DockerCall '^compose -f \S+ -f \S+ --profile omo stop\z') -and -not $arretSources.Host.Contains('Salle non demarree')) (Get-Extract ((Get-DockerJournal | ForEach-Object { (@($_.args) -join ' ') }) -join ' | '))

    $quoted = Invoke-CockpitProcess -FilePath (Get-TestGit) -Arguments @('-C', $full.Directory, 'rev-parse', '--sq-quote', '@{u}', '@{u}..HEAD') -TimeoutSec 60
    Assert-Test "P8 : '@{u}' transmis intact a git par Invoke-CockpitProcess" ($quoted.ExitCode -eq 0 -and $quoted.StdOut.Trim() -ceq "'@{u}' '@{u}..HEAD'") ($quoted.StdOut.Trim() + $quoted.StdErr.Trim())

    Write-Host ''
    Write-Host ('Total : {0} verifications, {1} en echec.' -f ($Results.Pass + $Results.Fail), $Results.Fail) -ForegroundColor (@('Green', 'Red')[[int]($Results.Fail -gt 0)])
    foreach ($failure in $Results.Failures) { Write-Host ('  - ' + $failure) -ForegroundColor Red }
} finally {
    foreach ($server in $Servers) {
        try { $server.StandardInput.Close() } catch { }
        try { if (-not $server.WaitForExit(5000)) { $server.Kill() } } catch { }
        try { $server.Dispose() } catch { }
    }
    foreach ($name in $EnvNames) { [Environment]::SetEnvironmentVariable($name, $SavedEnv[$name], 'Process') }
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
if ($Results.Fail -gt 0) { exit 1 }
exit 0
