# CockpitTls.ps1 - bibliotheque commune d'install.ps1 et cockpit.ps1 (opencode-cockpit 1.0.5).
# Chargee par dot-sourcing apres Assert-CockpitFullLanguage. ASCII + BOM, CRLF, 800 lignes au plus. Aucun etat global .NET modifie.
# curl et git : Invoke-CockpitProcess. docker : Invoke-CockpitDocker (variables de compose masquees, -f explicite).
#
# Contrat stable ($Mode = 'https' | 'http', ou objet rendu par Get-CockpitLocalMode) :
#   Get-CockpitLocalMode $Config -> { Scheme ('https'|'http'|$null) ; ConfirmedAt ; Raw ; Valid ; Problem }
#   Get-CockpitTransition -Mode <mode lu> -IsNew <bool> -IsMigration <bool> [-Http] [-Https]
#     -> 'EntreeHttps' | 'EntreeHttp' | 'ResteHttps' | 'ResteHttp' | 'Invalide'  (plan 3.4.1)
#   Get-CockpitPrecheckProblems -Transition -Mode -Policy -AcceptBrowserBlock <bool> -IsMigration <bool>
#       -LoadProblem <detail A-Load, '' si aucun> -Port <int> -Version <scripts> -PreviousVersion <version remplacee>
#     -> { Problems = @({ Code ; Lines }) : A18|A2, A-Load, A2-Load, A2-Update ; Warnings = @({ Code ; Lines }) }
#        Problems non vide (Warnings alors vide) : afficher Problems (Write-CockpitLines), puis un seul throw $CockpitA19.
#   Wait-CockpitHealth -Root -Port -Mode -Token [-TimeoutSec] [-Methods] [-CurlPath] [-PollSec] [-TlsState]
#     -> { Reason ; Method ; Status ; Version ; Detail ; Ticket ; Retry ; TlsState ; ContainerHealth }
#        Reason : Ok | NonDisponible | Poignee | EmpreinteDifferente | CertificatRefuse | Refus | ImageAncienne
#                 | SchemaDifferent | PreuveInvalide | JetonHorsFormat | AucuneVoie
#   Get-CockpitLoginUrl -Health -Port -Mode -Token [-TlsState] -> { Url ($null si refus) ; Reason ; Detail }
#   Get-CockpitOpenDecision -Health -Mode -Policy -> { Decision ('Open'|'NotOk') ; Lines }

Set-StrictMode -Version 2.0

# Variables interpolees par docker-compose.yml, plus celles qui choisissent les fichiers compose (plan 3.3).
$CockpitComposeEnvNames = @('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'COCKPIT_TLS_INSECURE', 'COCKPIT_PROJECT_CONFIG',
    'COCKPIT_GITHUB_ENTERPRISE_DOMAIN', 'TZ', 'COCKPIT_OPENCODE_IMAGE', 'COCKPIT_APP_IMAGE', 'COCKPIT_VERSION',
    'OPENCODE_SERVER_PASSWORD', 'WORKSPACE_DIR', 'ARCHIVE_DIR', 'COCKPIT_TOKEN', 'COCKPIT_ALLOWED_HOSTS',
    'COCKPIT_ALLOWED_PROVIDERS', 'COCKPIT_COPILOT_API_URL', 'COCKPIT_PORT', 'COCKPIT_LOCAL_SCHEME',
    'COCKPIT_LOCAL_HTTP_CONFIRMED', 'COCKPIT_AUTONOMY', 'COCKPIT_FICHIERS', 'COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_PROFILES', # nav
    # Variables du cockpit du contrat de la salle (docker\opencode-omo\contrat-salle.json, variables.cockpit) :
    # egalite verifiee par tests\ps51\Test-CockpitTls.ps1.
    'COCKPIT_OMO', 'OPENCODE_OMO_URL', 'OPENCODE_OMO_PASSWORD', 'COCKPIT_OMO_IMAGE', 'COCKPIT_OMO_CONTROL_DIR',
    'COCKPIT_OMO_STATE_DIR', 'COCKPIT_OMO_AUTH_DIR', 'COCKPIT_OMO_PROJECTS_FILE', 'COCKPIT_EGRESS_JOURNAL',
    # Variable de la salle (variables.salle du contrat) que docker-compose.yml lit aussi dans l'environnement : autorite
    # d'entreprise facultative, chemin d'un fichier DANS le conteneur. Elle doit venir du .env, jamais du shell (K1-1).
    'NODE_EXTRA_CA_CERTS')
# Surcharge du profil de la salle, generee par install.ps1 (D-2b-28) : jamais ecrite a la main, jamais ramassee
# toute seule par compose (son nom n'est pas un nom de surcharge automatique).
$CockpitOmoOverlay = 'docker-compose.omo-projets.yml'
# Etat propre a ce processus PowerShell : A8 une seule fois, echec d'Add-Type memorise.
$CockpitTlsSession = @{ A8Shown = $false; AddTypeError = $null; OmoNotice = $false }
$CockpitA19 = 'Installation arretee avant toute modification (voir les messages ci-dessus).'

# Masque les formes de secrets les plus courantes avant affichage (identifiants dans une URL, jetons GitHub, mots de passe).
function Hide-Secrets([string]$Text) {
    $masked = $Text -replace '(?i)([a-z][a-z0-9+.-]*://[^:\s/@]+:)[^@\s]+@', '$1****@'
    $masked = $masked -replace '(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}', '$1****'
    $masked = $masked -replace '(?i)(authorization\s*[:=]\s*(bearer|basic|token)\s+)\S+', '$1****'
    $masked = $masked -replace '(?i)((pass(word|wd)?|pwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+', '$1****'
    return $masked
}

function Assert-CockpitFullLanguage {
    $languageMode = [string]$ExecutionContext.SessionState.LanguageMode
    if ($languageMode -ne 'FullLanguage') { throw ("PowerShell est en mode de langage {0} sur ce poste (strategie AppLocker ou WDAC) : les scripts du cockpit exigent FullLanguage. Aucune modification. Lancez-les depuis un dossier autorise par l'informatique." -f $languageMode) }
}

# --- Processus natifs et docker compose (plan 3.3) ------------------------------------------------------------------
# Regles de CommandLineToArgvW ; les metacaracteres de cmd.exe sont aussi entoures de guillemets (sans effet pour un .exe).
function ConvertTo-CockpitArgText([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"&|<>^%()]') { return $Value }
    $builder = New-Object System.Text.StringBuilder '"'
    $slashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq '\') { $slashes++; continue }
        if ($ch -eq '"') { [void]$builder.Append('\', 2 * $slashes + 1) } elseif ($slashes -gt 0) { [void]$builder.Append('\', $slashes) }
        [void]$builder.Append($ch)
        $slashes = 0
    }
    return $builder.Append('\', 2 * $slashes).Append('"').ToString()
}

# Seule voie pour curl, git et docker : sorties separees lues en asynchrone (une ligne stderr ne leve rien, meme sous
# ErrorActionPreference = 'Stop'), delai avec arret du processus, variables retirees de l'environnement de l'enfant seulement.
function Invoke-CockpitProcess {
    param([string]$FilePath, [string[]]$Arguments = @(), [int]$TimeoutSec = 60, [string[]]$RemoveEnv = @())
    if (-not $FilePath -or -not [System.IO.Path]::IsPathRooted($FilePath)) { throw 'Invoke-CockpitProcess : chemin absolu attendu.' }
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo -Property @{ FileName = $FilePath; UseShellExecute = $false; CreateNoWindow = $true
        RedirectStandardInput = $true; RedirectStandardOutput = $true; RedirectStandardError = $true; StandardOutputEncoding = $utf8; StandardErrorEncoding = $utf8
        Arguments = (@($Arguments | ForEach-Object { ConvertTo-CockpitArgText $_ }) -join ' ') }
    foreach ($name in @($RemoveEnv)) { if ($name -and $startInfo.EnvironmentVariables.ContainsKey($name)) { $startInfo.EnvironmentVariables.Remove($name) } }
    $process = [System.Diagnostics.Process]::Start($startInfo)
    try {
        $process.StandardInput.Close(); $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit([Math]::Max(1, $TimeoutSec) * 1000)) {
            try { $process.Kill() } catch { }
            return [pscustomobject]@{ ExitCode = -1; StdOut = ''; StdErr = ''; TimedOut = $true }
        }
        $process.WaitForExit()
        return [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = $stdout.Result; StdErr = $stderr.Result; TimedOut = $false }
    } finally { $process.Dispose() }
}

# Masquage pendant un appel par & ; le nom reel est conserve (http_proxy en minuscules restauree telle quelle).
function Clear-CockpitComposeEnv {
    $saved = @{}
    foreach ($name in @([Environment]::GetEnvironmentVariables('Process').Keys | Where-Object { $CockpitComposeEnvNames -contains $_ })) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    return $saved
}

function Restore-CockpitComposeEnv($Saved) { foreach ($name in @($Saved.Keys)) { [Environment]::SetEnvironmentVariable($name, $Saved[$name], 'Process') } }

# Interrupteur de la salle : vrai seulement si .env porte exactement COCKPIT_OMO=on (toute autre valeur, fichier absent
# ou illisible = salle coupee). COCKPIT_OMO_IMAGE ne correspond pas : le nom est suivi d'un souligne, pas d'un egal.
function Test-CockpitOmoEnabled([string]$Root) {
    if (-not $Root) { return $false }
    $file = Join-Path $Root '.env'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
    try { $lines = [System.IO.File]::ReadAllLines($file) } catch { return $false }
    foreach ($line in $lines) { if ($line -cmatch '^\s*COCKPIT_OMO\s*=\s*on\s*\z') { return $true } }
    return $false
}
# Relecture 2ter-vague-3 : entrees que la surcharge d'install.ps1 ouvre en ecriture et qui ont disparu, change de forme (fichier, dossier) ou sont devenues lien ou jonction depuis la generation ; Docker les recreerait en DOSSIER vide sur le poste, ou suivrait la jonction hors du dossier de travail. Ligne hors format : a regenerer.
function Get-CockpitOmoSourceProblems([string]$Root) {
    $salle = $false; $overlay = Join-Path $Root $CockpitOmoOverlay; if (-not (Test-Path -LiteralPath $overlay -PathType Leaf)) { return }
    foreach ($line in [System.IO.File]::ReadAllLines($overlay)) {
        if ($line -cmatch '^  ([^ #]+):\s*\z') { $salle = ($Matches[1] -ceq 'opencode-omo') } elseif (-not $salle -or -not $line.StartsWith('      - ')) { }
        elseif ($line -cnotmatch '^      - \{ type: bind, source: "([^"]+)", target: "/workspace/([^"]+)", bind: \{ create_host_path: false \} \} # (fichier|dossier)\z') { 'surcharge a regenerer' }
        elseif ($null -eq ($item = Get-Item -LiteralPath ($Matches[1] -replace '\$\$', '$$') -Force -ErrorAction SilentlyContinue) -or ([int]$item.Attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0 -or ($item -is [System.IO.DirectoryInfo]) -ne ($Matches[3] -ceq 'dossier')) { $Matches[2] -replace '\$\$', '$$' }
    }
}

# Fonction simple, sans [Parameter()] : des options docker comme -v ou -d ne sont jamais prises pour -Verbose ou -Debug.
function ConvertTo-CockpitDockerArgs([string]$Root, [object[]]$DockerArgs) {
    $list = @($DockerArgs | ForEach-Object { [string]$_ })
    if ($list.Count -eq 0 -or $list[0] -cne 'compose' -or ($list.Count -gt 1 -and $list[1] -ceq 'version')) { return , $list }
    if (-not $Root) { throw 'Dossier du cockpit requis pour une commande docker compose.' }
    $prefix = @('compose', '-f', (Join-Path $Root 'docker-compose.yml'))
    # Surcharge des projets prepares (D-2b-28, L16c) : ses montages en ecriture s'ajoutent a ceux du fichier de base.
    if (Test-Path -LiteralPath (Join-Path $Root $CockpitOmoOverlay) -PathType Leaf) { $prefix += @('-f', (Join-Path $Root $CockpitOmoOverlay)) }
    # Profil de la salle sur TOUTES les commandes, stop et down compris : sans lui, le service du profil reste en vie
    # et le reseau du projet ne peut pas etre supprime (MO-3 point 2). COMPOSE_PROFILES n'est jamais melangee a
    # --profile (MO-3 point 3) : elle est retiree de l'environnement de l'enfant par $CockpitComposeEnvNames.
    # Jamais, en revanche, pour creer ou demarrer un conteneur quand une source de la surcharge manque ou a change (relecture 2ter-vague-3).
    $blocked = @(if ((Test-CockpitOmoEnabled $Root) -and @('up', 'create', 'start', 'restart', 'run') -ccontains $list[1]) { Get-CockpitOmoSourceProblems $Root })
    if ((Test-CockpitOmoEnabled $Root) -and $blocked.Count -eq 0) { $prefix += @('--profile', 'omo') } elseif ($blocked.Count -gt 0 -and -not $CockpitTlsSession.OmoNotice) { $CockpitTlsSession.OmoNotice = $true; Write-Host ('    [!] Salle non demarree : depuis install.ps1, ces entrees de premier niveau ont ete supprimees, renommees ou remplacees par un lien ou une jonction : {0}. Relancez install.ps1 ; sans cela Docker recreerait un dossier vide a leur place sur le poste. Le reste du cockpit demarre.' -f (@($blocked | Select-Object -First 20) -join ', ')) -ForegroundColor Yellow }
    return , ($prefix + @($list | Select-Object -Skip 1))
}

function Invoke-CockpitDocker([string]$Root, [object[]]$DockerArgs, [int]$TimeoutSec = 60) {
    # Chemin absolu (jamais un docker.exe du dossier courant) ; le fichier "docker" sans extension de Docker Desktop est ignore.
    $docker = @(Get-Command docker -CommandType Application -ErrorAction Stop | Where-Object { @('.exe', '.cmd', '.bat') -contains $_.Extension })[0].Source
    return (Invoke-CockpitProcess -FilePath $docker -Arguments (ConvertTo-CockpitDockerArgs $Root $DockerArgs) -TimeoutSec $TimeoutSec -RemoveEnv $CockpitComposeEnvNames)
}

# --- Migration du web 1.0.x -> 1.1.0 (decision A37, fiche MW 1.2, 1.3, 3 et 7) ---------------------------------------------------
# Verdict de server/migrate-oc-config.ts : la SEULE ligne non vide de stdout, confrontee a cette expression ancree.
$CockpitWebMigrationPattern = '^migration-web etat=(absent|conforme|migre|non-migre|erreur) profil=(prudent|equilibre|autonome|-) fichier=(opencode\.jsonc|opencode\.json|config\.json|-) blocs=([0-9]{1,4}) restes=([0-9]{1,4}) sauvegarde=((opencode\.jsonc|opencode\.json|config\.json)\.avant-1\.1\.0|existante|-) raison=([a-z-]{1,24})\z'

function New-CockpitWebMigrationResult([string]$Etat, [string]$Raison, [string]$Profil = '-', [string]$Fichier = '-', [int]$Blocs = 0, [int]$Restes = 0, [string]$Sauvegarde = '-') {
    return [pscustomobject]@{ Etat = $Etat; Profil = $Profil; Fichier = $Fichier; Blocs = $Blocs; Restes = $Restes; Sauvegarde = $Sauvegarde; Raison = $Raison }
}

# Options du conteneur jetable, dans l'ordre de la fiche : aucune variable ni --env-file, aucun reseau, aucun privilege, image
# jamais tiree. Le banc e2e (e2e/lib/docker-e2e.mjs, section mw:) utilise la MEME liste (app/server/migrate-oc-config.test.ts).
function Get-CockpitWebMigrationArgs([string]$Project, [string]$Image, [string]$Name) {
    return @('run', '--rm', '--pull', 'never', '--name', $Name, '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pids-limit', '32', '-v', ($Project + '_oc-config:/oc-config'), '--entrypoint', 'node', $Image,
        '--no-warnings', 'server/migrate-oc-config.ts', '/oc-config')
}

# Retrait du conteneur jetable (delai, sortie inattendue) AVANT de rendre la main : Invoke-CockpitProcess ne tue que le client
# docker, et le conteneur continuerait d'ecrire apres le redemarrage d'opencode. Erreur ignoree.
function Remove-CockpitWebMigrationContainer([string]$Name) {
    try { [void](Invoke-CockpitDocker '' @('rm', '-f', $Name) 30) } catch { }
}

# Migration du web du volume <Project>_oc-config, opencode ARRETE par l'appelant (install | nostart | restore). Ne leve JAMAIS :
# tout echec rend Etat 'erreur'. -> { Etat ; Profil ; Fichier ; Blocs ; Restes ; Sauvegarde ; Raison }. Stderr jamais lu.
function Invoke-CockpitWebMigration([string]$Root, [string]$Project, [string]$Image, [string]$Contexte, [int]$TimeoutSec = 120) {
    $name = $null
    try {
        if (@('install', 'nostart', 'restore') -cnotcontains $Contexte -or $Project -cnotmatch '^[a-z0-9][a-z0-9_-]*\z') { return (New-CockpitWebMigrationResult 'erreur' 'interne') }
        # Image : jamais une option (comme Get-CockpitImageVersion), jamais hors du format d'une reference d'image.
        if (-not $Image -or $Image.StartsWith('-') -or $Image -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}\z') { return (New-CockpitWebMigrationResult 'erreur' 'docker') }
        $bytes = New-Object byte[] 4; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $name = '{0}-migration-web-{1}' -f $Project, (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
        $result = Invoke-CockpitDocker $Root (Get-CockpitWebMigrationArgs $Project $Image $name) $TimeoutSec
        if ($result.TimedOut) { Remove-CockpitWebMigrationContainer $name; return (New-CockpitWebMigrationResult 'erreur' 'delai') }
        $lines = @(([string]$result.StdOut -split "`r?`n") | Where-Object { $_.Trim() -ne '' })
        # Code coherent avec l'etat : 1 pour 'erreur', 0 sinon.
        if ($lines.Count -eq 1 -and $lines[0] -cmatch $CockpitWebMigrationPattern -and @(0, 1) -contains $result.ExitCode -and (($Matches[1] -ceq 'erreur') -eq ($result.ExitCode -eq 1))) {
            return (New-CockpitWebMigrationResult $Matches[1] $Matches[8] $Matches[2] $Matches[3] ([int]$Matches[4]) ([int]$Matches[5]) $Matches[6])
        }
        Remove-CockpitWebMigrationContainer $name
        if ($lines.Count -eq 0 -and @(0, 1) -notcontains $result.ExitCode) { return (New-CockpitWebMigrationResult 'erreur' 'docker') }
        return (New-CockpitWebMigrationResult 'erreur' 'sortie-inattendue')
    } catch {
        if ($name) { Remove-CockpitWebMigrationContainer $name }
        return (New-CockpitWebMigrationResult 'erreur' 'docker')
    }
}

# Lignes ASCII de l'installateur (fiche MW 7) : rien pour 'absent' ni pour 'conforme' sans reste ; au plus cinq lignes sous l'en-tete.
function Get-CockpitWebMigrationLines($Result, [string]$Contexte) {
    if ($null -eq $Result -or $Result.Etat -ceq 'absent' -or ($Result.Etat -ceq 'conforme' -and $Result.Restes -eq 0)) { return }
    $lines = @("==> Passage a la 1.1.0 : l'assistant ne va plus sur Internet")
    if ($Contexte -ceq 'restore') { $lines = @('==> Regles Internet de la sauvegarde restauree') }
    $labels = @{ prudent = 'Prudent'; equilibre = 'Equilibre'; autonome = 'Sans confirmation' }
    $profil = $labels.ContainsKey([string]$Result.Profil)
    $restes = "    [!] Certaines regles demandent encore l'acces a Internet : voir Parametres > Securite."
    if ($Result.Etat -ceq 'migre') {
        if ($profil) { $lines += ("    [OK] Profil de droits {0} conserve : seul l'acces a Internet est desormais refuse." -f $labels[[string]$Result.Profil]) }
        else { $lines += '    [OK] Vos regles personnalisees sont conservees : seules les regles Internet "sur demande" sont desormais refusees.' }
        $lines += "    C'etait deja impossible depuis la 1.0.6 (seul GitHub Copilot est joignable), et une demande restee sans reponse pouvait bloquer les autres autorisations."
        $lines += ("    Copie de l'ancien fichier : {0}.avant-1.1.0, dans le volume de configuration d'opencode (compris dans .\cockpit.ps1 backup)." -f $Result.Fichier)
        if ($Result.Restes -gt 0) { $lines += $restes }
        if ($Contexte -ceq 'nostart') { $lines += '    Le fichier est a jour ; il sera lu au prochain demarrage (.\cockpit.ps1 start).' }
        return $lines
    }
    if ($Result.Etat -ceq 'conforme') { return ($lines + $restes) }
    if ($Result.Raison -ceq 'opencode-actif' -and $Contexte -ceq 'nostart') { return ($lines + '    [!] Regles Internet non mises a jour : opencode est en marche. Relancez .\install.ps1 sans -NoStart ; en attendant : Parametres > Securite.') }
    $reasons = @{ 'plusieurs-fichiers' = 'plusieurs fichiers de configuration'; 'illisible' = 'fichier de configuration illisible'; 'cle-en-double' = 'regle ecrite deux fois'
        'inhabituel' = 'fichier de configuration inhabituel'; 'lien-ou-special' = 'fichier de configuration remplace par un lien ou un element special'
        'trop-gros' = 'fichier de configuration trop gros'; 'modifie-pendant' = 'fichier modifie pendant la mise a jour'
        'sauvegarde-impossible' = 'copie de securite impossible'; 'opencode-actif' = "opencode n'a pas pu etre arrete" }
    $text = 'verification impossible'
    if ($Result.Etat -ceq 'non-migre' -and $reasons.ContainsKey([string]$Result.Raison)) { $text = $reasons[[string]$Result.Raison] }
    $lines += ('    [!] Regles Internet laissees telles quelles ({0}).' -f $text)
    if ($profil) { $lines += "    Reglage conseille : Parametres > Securite > Fermer l'acces a Internet (votre profil est garde)." }
    else { $lines += "    Si l'assistant reste bloque sur une demande d'acces a Internet, refusez-la. En mode Avance : Parametres > opencode, mettez webfetch et websearch a deny." }
    return $lines
}

# Configuration resolue par compose (P3), en memoire seulement : elle contient des secrets, jamais affichee ni citee. Illisible :
# exception, jamais de valeur par defaut (repetition generale F2). PS 5.1 : ConvertFrom-Json refuse deux cles qui ne different
# que par la casse (HTTP_PROXY et http_proxy d'un service depuis la 1.0.6). Les chaines sont lues de gauche a droite ; dans une
# cle sans echappement, '^' devient '^^' et une majuscule ASCII '^' + minuscule : des cles distinctes le restent sans la casse,
# et les cles lues (name, services, volumes, target, source), en minuscules, ne changent pas.
function Read-CockpitComposeConfig([string]$Root) {
    $result = Invoke-CockpitDocker $Root @('compose', 'config', '--format', 'json') 60
    if ($result.TimedOut) { throw 'docker compose config ne repond pas en 60 s : Docker Desktop est bloque ? Redemarrez-le (wsl --shutdown, puis relancez Docker Desktop).' }
    if ($result.ExitCode -ne 0 -or -not $result.StdOut) { throw ('Lecture de la configuration impossible (docker compose config, code {0}).' -f $result.ExitCode) }
    $lettre = [System.Text.RegularExpressions.MatchEvaluator]{ param($m) if ($m.Value -ceq '^') { '^^' } else { '^' + $m.Value.ToLowerInvariant() } }
    $chaine = [System.Text.RegularExpressions.MatchEvaluator]{ param($m) if (-not $m.Groups[1].Success -or $m.Value.Contains('\')) { $m.Value } else { [regex]::Replace($m.Value, '[\^A-Z]', $lettre) } }
    $texte = [regex]::Replace([string]$result.StdOut, '"(?:[^"\\]|\\.)*"(\s*:)?', $chaine)
    try { $config = ConvertFrom-Json $texte } catch { $config = $null }
    # Un objet JSON, rien d'autre (un tableau serait deroule par return, et son premier element lu comme la configuration).
    if ($config -isnot [System.Management.Automation.PSCustomObject]) { throw 'Configuration docker compose illisible (docker compose config --format json).' }
    return $config
}

# Nom du projet tel que compose le resout. Illisible ou hors format : exception, JAMAIS un nom fixe, qui designerait les volumes
# d'une autre installation (chown -R, migration du web, sauvegarde, restauration, -Purge).
function Get-CockpitComposeProjectName([string]$Root) {
    $config = Read-CockpitComposeConfig $Root
    $name = $null
    if ($null -ne $config -and $null -ne $config.PSObject.Properties['name']) { $name = [string]$config.name }
    if ($name -cnotmatch '^[a-z0-9][a-z0-9_-]*\z') { throw 'Nom de projet docker compose inattendu.' }
    return $name
}

# Causes possibles d'un schema servi different de .env : noms des variables (jamais les valeurs) et fichiers voisins.
# $CockpitOmoOverlay n'est pas un fichier voisin inattendu : il est genere par install.ps1 et passe explicitement
# par ConvertTo-CockpitDockerArgs, donc il ne figure jamais dans la liste.
function Get-CockpitComposeDivergence([string]$Root, [string[]]$Scopes = @('Process', 'User', 'Machine')) {
    $variables = @(foreach ($scope in $Scopes) {
        $present = @([Environment]::GetEnvironmentVariables($scope).Keys)
        foreach ($name in $CockpitComposeEnvNames) { if ($present -contains $name) { [pscustomobject]@{ Name = $name; Scope = $scope } } }
    })
    $candidates = @('docker-compose.override.yml', 'docker-compose.override.yaml', 'compose.override.yml', 'compose.override.yaml', 'compose.yaml', 'compose.yml')
    return [pscustomobject]@{ Variables = $variables; Files = @($candidates | Where-Object { Test-Path -LiteralPath (Join-Path $Root $_) -PathType Leaf }) }
}

# COCKPIT_VERSION d'une IMAGE (jamais d'un conteneur, dont l'environnement contient les secrets).
function Get-CockpitImageVersion([string]$Image) {
    if (-not $Image -or $Image.StartsWith('-')) { return $null }
    $result = Invoke-CockpitDocker '' @('image', 'inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', $Image) 60
    if ($result.ExitCode -eq 0 -and $result.StdOut -cmatch '(?m)^COCKPIT_VERSION=([0-9]+)\.([0-9]+)\.([0-9]+)') { return [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3]) }
    return $null
}

# 'https' | 'http' | 'inconnu' (valeur servie hors liste, jamais recopiee) | $null (conteneur illisible).
function Get-CockpitServedScheme([string]$Root) {
    $result = Invoke-CockpitDocker $Root @('compose', 'exec', '-T', 'cockpit', 'printenv', 'COCKPIT_LOCAL_SCHEME') 20
    if ($result.ExitCode -ne 0) { return $null } elseif ($result.StdOut.Trim() -ceq '') { return 'https' }
    if (@('https', 'http') -ccontains $result.StdOut.Trim()) { return $result.StdOut.Trim() } else { return 'inconnu' }
}

# Sante Docker du conteneur cockpit : healthy | starting | unhealthy | '' (absent ou illisible).
function Get-CockpitContainerHealth([string]$Root) {
    $ps = Invoke-CockpitDocker $Root @('compose', 'ps', '-q', 'cockpit') 20
    $id = @(($ps.StdOut -split "`r?`n") | Where-Object { $_ -cmatch '^[0-9a-f]{12,64}\z' })
    if ($ps.ExitCode -ne 0 -or $id.Count -eq 0) { return '' }
    $inspect = Invoke-CockpitDocker $Root @('inspect', '--format', '{{.State.Health.Status}}', $id[0]) 20
    if ($inspect.ExitCode -ne 0) { return '' }
    return $inspect.StdOut.Trim()
}

# --- Mode d'acces lu dans .env (plan 3.2.2 ; [0-9] et \z : le \d et le $ de .NET sont plus larges que ceux de Node) ---

function Test-CockpitConfirmedAt([string]$Text) {
    $at = ([string]$Text).Trim()
    if ($at -cnotmatch '^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z\z') { return $false }
    $invariant = [System.Globalization.CultureInfo]::InvariantCulture
    $parsed = [datetime]::MinValue
    if (-not [datetime]::TryParseExact($at, "yyyy-MM-dd'T'HH:mm:ss'Z'", $invariant, [System.Globalization.DateTimeStyles]'AssumeUniversal, AdjustToUniversal', [ref]$parsed)) { return $false }
    return ($parsed.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", $invariant) -ceq $at)
}

# Ne leve jamais d'exception ; Problem ne recopie jamais la valeur lue.
function Get-CockpitLocalMode($Config) {
    $raw = $null; $at = $null
    try {
        if ($Config.Contains('COCKPIT_LOCAL_SCHEME') -and $null -ne $Config['COCKPIT_LOCAL_SCHEME']) { $raw = [string]$Config['COCKPIT_LOCAL_SCHEME'] }
        if ($Config.Contains('COCKPIT_LOCAL_HTTP_CONFIRMED') -and $null -ne $Config['COCKPIT_LOCAL_HTTP_CONFIRMED']) { $at = [string]$Config['COCKPIT_LOCAL_HTTP_CONFIRMED'] }
    } catch { $raw = 'illisible' }
    $mode = [pscustomobject]@{ Scheme = $null; ConfirmedAt = $null; Raw = $raw; Valid = $false; Problem = 'valeur non reconnue' }
    $scheme = ''
    if ($null -ne $raw) { $scheme = $raw.Trim() }
    if ($scheme -ceq '' -or $scheme -ceq 'https') { $mode.Scheme = 'https'; $mode.Valid = $true; $mode.Problem = $null }
    elseif ($scheme -ceq 'http' -and $null -ne $at -and (Test-CockpitConfirmedAt $at)) { $mode.Scheme = 'http'; $mode.ConfirmedAt = $at.Trim(); $mode.Valid = $true; $mode.Problem = $null }
    elseif ($scheme -ceq 'http') { $mode.Problem = 'COCKPIT_LOCAL_SCHEME=http sans date de confirmation valable' }
    return $mode
}

function Get-CockpitSchemeOf($Mode) {
    $scheme = ''
    if ($Mode -is [string]) { $scheme = $Mode } elseif ($Mode -is [System.Collections.IDictionary]) { $scheme = [string]$Mode['Scheme'] }
    elseif ($null -ne $Mode -and $Mode.PSObject.Properties['Scheme']) { $scheme = [string]$Mode.Scheme }
    if ($scheme -cne 'https' -and $scheme -cne 'http') { throw 'Mode d acces attendu : https ou http.' }
    return $scheme
}

function Test-CockpitGeneratedToken([string]$Token) { return ([string]$Token -cmatch '^[0-9a-f]{64}\z') }

# Seul endroit qui construit l'adresse locale du cockpit.
function Get-CockpitBaseUrl([string]$Scheme, [int]$Port) {
    if (($Scheme -cne 'https' -and $Scheme -cne 'http') -or $Port -lt 1 -or $Port -gt 65535) { throw 'Adresse locale invalide (schema https ou http, port 1 a 65535).' }
    return ('{0}://127.0.0.1:{1}' -f $Scheme, $Port)
}

function New-CockpitChallenge {
    $bytes = New-Object byte[] 32; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

# HMAC-SHA256 (vecteurs communs) : cle = octets UTF-8 du jeton ; message = opencode-cockpit/<usage>/v1 + LF + donnee.
# Usages : preuve servie (health-proof), demande de ticket signee par les scripts (auth-ticket-request), lien (auth-ticket).
function Get-CockpitHmacHex([string]$Token, [string]$Purpose, [string]$Data) {
    if ($Purpose -cne 'health-proof' -and $Purpose -cne 'auth-ticket-request' -and $Purpose -cne 'auth-ticket') { throw 'Usage HMAC inconnu.' }
    $hmac = New-Object System.Security.Cryptography.HMACSHA256 -ArgumentList (, [System.Text.Encoding]::UTF8.GetBytes($Token))
    try { $mac = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes("opencode-cockpit/$Purpose/v1`n$Data")) } finally { $hmac.Dispose() }
    return (($mac | ForEach-Object { $_.ToString('x2') }) -join '')
}

# --- Certificat public du cockpit (HTTPS) --------------------------------------------------------------------------
function Format-CockpitFingerprint([string]$Hex) {
    $clean = ([string]$Hex).Replace(':', '').ToUpperInvariant()
    if ($clean -cnotmatch '^[0-9A-F]{64}\z') { throw 'Empreinte SHA-256 invalide.' }
    return ((0..31 | ForEach-Object { $clean.Substring($_ * 2, 2) }) -join ':')
}

# Texte PEM -> DER : exactement un bloc CERTIFICATE ; tout texte contenant une cle privee est refuse.
function ConvertFrom-CockpitPem([string]$Text) {
    if ([string]::IsNullOrWhiteSpace($Text)) { throw 'Certificat vide.' }
    if ($Text.IndexOf('PRIVATE KEY', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Le texte lu contient une cle privee : lecture refusee.' }
    $found = [regex]::Matches($Text, '-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----')
    if ($found.Count -ne 1) { throw ('{0} certificat(s) PEM trouve(s) : exactement 1 attendu.' -f $found.Count) }
    try { $der = [Convert]::FromBase64String(($found[0].Groups[1].Value -replace '\s', '')) } catch { throw 'Certificat PEM illisible (base64 invalide).' }
    if ($der.Length -lt 100 -or $der.Length -gt 16384) { throw 'Certificat PEM de taille inattendue.' }
    return , $der
}

# Contre-verification du certificat public et de cockpit-tls.json : toute incoherence leve une exception.
function ConvertTo-CockpitTlsState([string]$PemText, [string]$JsonText) {
    $der = ConvertFrom-CockpitPem $PemText
    $json = $null
    if ($JsonText -and $JsonText.IndexOf('PRIVATE KEY', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { try { $json = ConvertFrom-Json $JsonText } catch { $json = $null } }
    if ($null -eq $json -or @('sha256Hex', 'spkiSha256Base64', 'san' | Where-Object { -not $json.PSObject.Properties[$_] }).Count -gt 0) { throw 'Incoherence du certificat publie : cockpit-tls.json illisible ou incomplet.' }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $cert = $null
    try {
        $hex = [BitConverter]::ToString($sha.ComputeHash($der)).Replace('-', '').ToLowerInvariant()
        if ([string]$json.sha256Hex -cne $hex) { throw 'Incoherence du certificat publie : empreinte du PEM differente de cockpit-tls.json.' }
        try { $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (, $der) } catch { throw 'Certificat publie illisible (structure X.509 invalide).' }
        # SPKI recalcule pour P-256, seule courbe generee par le cockpit : prefixe DER fixe + point non compresse.
        $point = $cert.PublicKey.EncodedKeyValue.RawData
        if ($cert.PublicKey.Oid.Value -cne '1.2.840.10045.2.1' -or [Convert]::ToBase64String($cert.PublicKey.EncodedParameters.RawData) -cne 'BggqhkjOPQMBBw==' -or $point.Length -ne 65) { throw 'Certificat publie inattendu : cle ECDSA P-256 attendue.' }
        $spki = [Convert]::ToBase64String($sha.ComputeHash([byte[]]([Convert]::FromBase64String('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgA=') + $point)))
        if ([string]$json.spkiSha256Base64 -cne $spki) { throw 'Incoherence du certificat publie : cle publique differente de cockpit-tls.json.' }
        # 127.0.0.1 cherche dans les octets DER du SAN (iPAddress [7], longueur 4 : 87 04 7F 00 00 01), independants de la langue.
        $sanBytes = @($cert.Extensions | Where-Object { $_.Oid.Value -ceq '2.5.29.17' } | ForEach-Object { [BitConverter]::ToString($_.RawData) }) -join '|'
        $previous = $null
        if ($json.PSObject.Properties['previousSha256']) { $previous = $json.previousSha256 }
        return [pscustomobject]@{ Der = $der; Sha256 = (Format-CockpitFingerprint $hex); Sha256Hex = $hex; SpkiBase64 = $spki; NotBefore = $cert.NotBefore.ToUniversalTime()
            NotAfter = $cert.NotAfter.ToUniversalTime(); San = @($json.san); HasIp127 = $sanBytes.Contains('87-04-7F-00-00-01'); PreviousSha256 = $previous }
    } finally { if ($null -ne $cert) { $cert.Dispose() }; $sha.Dispose() }
}

# $null tant que les fichiers publics manquent (demarrage) ; exception sur une incoherence.
function Read-CockpitTlsPublic([string]$Root) {
    $pem = Invoke-CockpitDocker $Root @('compose', 'exec', '-T', 'cockpit', 'cat', '/tls/public/cockpit.crt') 20
    $json = $null
    if ($pem.ExitCode -eq 0) { $json = Invoke-CockpitDocker $Root @('compose', 'exec', '-T', 'cockpit', 'cat', '/tls/public/cockpit-tls.json') 20 }
    if ($null -eq $json -or $json.ExitCode -ne 0) { return $null }
    return (ConvertTo-CockpitTlsState $pem.StdOut $json.StdOut)
}

# L'epinglage ignore dates et nom, le navigateur non. Blocking = le navigateur refusera la page.
function Get-CockpitCertWarnings($State, $Now = $null) {
    if ($null -eq $Now) { $Now = (Get-Date).ToUniversalTime() }
    $until = $State.NotAfter.ToString('yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture)
    if ($State.NotAfter -lt $Now) { [pscustomobject]@{ Code = 'expire'; Blocking = $true; Text = ('Certificat expire depuis le {0} (UTC) : le navigateur refusera la page. Renouvellement : .\cockpit.ps1 restart' -f $until) } }
    elseif ($State.NotAfter -lt $Now.AddDays(30)) { [pscustomobject]@{ Code = 'echeance'; Blocking = $false; Text = ('Certificat valable jusqu au {0} (UTC) : renouvele au prochain demarrage.' -f $until) } }
    if ($State.NotBefore -gt $Now.AddMinutes(5)) { [pscustomobject]@{ Code = 'futur'; Blocking = $true; Text = 'Certificat pas encore valable : verifiez l horloge de Windows.' } }
    if (-not $State.HasIp127) { [pscustomobject]@{ Code = 'san'; Blocking = $true; Text = 'Le certificat ne couvre pas l adresse 127.0.0.1 : le navigateur refusera la page.' } }
}

# --- Voies de verification (plan 3.7.2 a 3.7.4, 3.11) ---------------------------------------------------------------
function Get-CockpitCurl([string]$CurlPath) {
    if (-not $CurlPath) { $CurlPath = Join-Path ([Environment]::GetFolderPath('System')) 'curl.exe' }
    $curl = [pscustomobject]@{ Path = $CurlPath; Available = $false; Version = $null; Reason = 'absent' }
    $run = $null
    if (Test-Path -LiteralPath $CurlPath -PathType Leaf) { try { $run = Invoke-CockpitProcess -FilePath $CurlPath -Arguments @('--disable', '--version') -TimeoutSec 10 } catch { $run = $null } }
    if ($null -ne $run -and $run.ExitCode -eq 0 -and $run.StdOut -cmatch '^curl ([0-9]+)\.([0-9]+)\.([0-9]+)[^\r\n]*') {
        $curl.Version = [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3])
        if ($curl.Version -lt [version]'7.60.0') { $curl.Reason = ('version {0} anterieure a 7.60' -f $curl.Version) }
        elseif ($Matches[0] -notmatch '\bSchannel\b') { $curl.Reason = 'sans Schannel' } else { $curl.Available = $true; $curl.Reason = '' }
    }
    return $curl
}

function New-CockpitRaw([int]$Status, [string]$Body, [string]$Failure, [string]$Detail) { return [pscustomobject]@{ Status = $Status; Body = $Body; Failure = $Failure; Detail = $Detail } }
function Assert-CockpitHealthQuery([string]$Query) { if ($Query -cnotmatch '^challenge=[0-9a-f]{64}(&ticket=[0-9a-f]{64})?\z') { throw 'Requete de sante invalide.' } }

# Statut d'une WebException (ou de la classe C#) -> raison ; '' = erreur non classee.
function Get-CockpitFailureOf([string]$Status) {
    if (@('ConnectFailure', 'Timeout') -contains $Status) { return 'NonDisponible' }
    if (@('SecureChannelFailure', 'ReceiveFailure', 'ConnectionClosed', 'KeepAliveFailure', 'SendFailure') -contains $Status) { return 'Poignee' }
    if ($Status -ceq 'PinMismatch') { return 'EmpreinteDifferente' }
    if ($Status -ceq 'TrustFailure') { return 'CertificatRefuse' }
    return ''
}

# Arguments en liste, --disable en premier : aucun _curlrc n'est lu. Certificat public dans un fichier temporaire.
function Invoke-CockpitHealthCurl([string]$Scheme, [int]$Port, [string]$Query, $TlsState, [string]$CurlPath, [int]$TimeoutSec) {
    Assert-CockpitHealthQuery $Query
    $seconds = [Math]::Max(1, $TimeoutSec)
    $arguments = @('--disable', '--silent', '--show-error', '--noproxy', '127.0.0.1', '--proto', ('=' + $Scheme), '--max-time', [string]$seconds)
    $caFile = $null
    try {
        if ($Scheme -ceq 'https') {
            $caFile = (New-TemporaryFile).FullName
            [System.IO.File]::WriteAllText($caFile, ("-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($TlsState.Der, 'InsertLineBreaks') + "`n-----END CERTIFICATE-----`n"), [System.Text.Encoding]::ASCII)
            $arguments += @('--cacert', $caFile, '--pinnedpubkey', ('sha256//' + $TlsState.SpkiBase64))
        }
        $arguments += @('--output', '-', '--write-out', '\n%{http_code}', ((Get-CockpitBaseUrl $Scheme $Port) + '/api/health?' + $Query))
        $run = Invoke-CockpitProcess -FilePath $CurlPath -Arguments $arguments -TimeoutSec ($seconds + 5)
    } finally { if ($caFile) { Remove-Item -LiteralPath $caFile -Force -ErrorAction SilentlyContinue } }
    if ($run.TimedOut) { return (New-CockpitRaw 0 '' 'NonDisponible' 'delai depasse') }
    if ($run.ExitCode -eq 0 -and $run.StdOut -cmatch '(?s)^(.*)\n([0-9]{3})\s*\z') { return (New-CockpitRaw ([int]$Matches[2]) $Matches[1] '' '') }
    $failure = 'Refus'
    if ($run.ExitCode -eq 90) { $failure = 'EmpreinteDifferente' } elseif ($run.ExitCode -eq 60) { $failure = 'CertificatRefuse' }
    elseif (@(7, 28) -contains $run.ExitCode) { $failure = 'NonDisponible' } elseif (@(35, 52, 56) -contains $run.ExitCode) { $failure = 'Poignee' }
    $firstLine = @($run.StdErr -split "`r?`n")[0]
    return (New-CockpitRaw 0 '' $failure ('curl {0} : {1}' -f $run.ExitCode, (Hide-Secrets $firstLine)))
}

# Voie C# (Q3), HTTPS seulement : seul Add-Type des scripts, precede d'A8 une fois par processus.
function Initialize-CockpitPinnedHttp([string]$CurlReason) {
    if ($null -ne ('OpencodeCockpit.PinnedHttp' -as [type])) { return $true }
    if ($CockpitTlsSession.AddTypeError) { return $false }
    if (-not $CockpitTlsSession.A8Shown) {
        $CockpitTlsSession.A8Shown = $true
        $scripts = @(Get-PSCallStack | Where-Object { $_.ScriptName } | ForEach-Object { Split-Path -Leaf $_.ScriptName })
        $caller = @($scripts | Where-Object { @('install.ps1', 'cockpit.ps1') -contains $_ }) + @($scripts | Select-Object -Last 1)
        Write-CockpitLines @(('    Verification HTTPS : curl.exe indisponible ({0}).' -f $CurlReason),
            '    Voie de secours : petite classe .NET compilee par PowerShell (Add-Type : csc.exe et DLL temporaire dans %TEMP%).',
            ("    Votre antivirus ou votre EDR peut le signaler : il s'agit de cette verification, lancee par {0}." -f $caller[0]),
            "    Si elle est bloquee, aucune page ne sera ouverte ; l'empreinte a comparer sera affichee.")
    }
    $source = @'
using System; using System.IO; using System.Net; using System.Net.Security; using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates; using System.Text;
namespace OpencodeCockpit {
public static class PinnedHttp {
    // Rappel porte par la requete (aucun etat global). Rend { statut, corps, echec, detail } ; echec "" = reponse HTTP.
    // baseUrl vient de Get-CockpitBaseUrl et reste revalidee ici (https, 127.0.0.1, chemin de sante seulement).
    public static string[] Get(string baseUrl, string pathAndQuery, string pin, int timeoutMs) {
        if (baseUrl == null || pathAndQuery == null || !pathAndQuery.StartsWith("/api/health?") || pin == null || pin.Length != 64) { throw new ArgumentException("requete"); }
        Uri uri = new Uri(baseUrl + pathAndQuery);
        if (uri.Scheme != Uri.UriSchemeHttps || uri.Host != "127.0.0.1" || uri.AbsolutePath != "/api/health") { throw new ArgumentException("adresse hors perimetre"); }
        string expected = pin.ToUpperInvariant();
        bool mismatch = false;
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(uri);
        request.Proxy = null; request.AllowAutoRedirect = false; request.KeepAlive = false; request.Timeout = timeoutMs; request.ReadWriteTimeout = timeoutMs;
        request.ConnectionGroupName = "opencode-cockpit-" + expected;
        request.ServerCertificateValidationCallback = delegate (object sender, X509Certificate certificate, X509Chain chain, SslPolicyErrors errors) {
            bool same = false;
            if (certificate != null) { using (SHA256 sha = SHA256.Create()) { same = BitConverter.ToString(sha.ComputeHash(certificate.GetRawCertData())).Replace("-", "") == expected; } }
            if (!same) { mismatch = true; }
            return same;
        };
        HttpWebResponse response = null;
        try {
            try { response = (HttpWebResponse)request.GetResponse(); } catch (WebException ex) {
                response = ex.Response as HttpWebResponse;
                if (response == null) { return new string[] { "0", "", mismatch ? "PinMismatch" : ex.Status.ToString(), ex.Message }; }
            }
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                char[] buffer = new char[65536]; int total = 0; int read;
                while (total < buffer.Length && (read = reader.Read(buffer, total, buffer.Length - total)) > 0) { total += read; }
                return new string[] { ((int)response.StatusCode).ToString(), new string(buffer, 0, total), "", "" };
            }
        } catch (IOException ex) { return new string[] { "0", "", "ReceiveFailure", ex.Message };
        } finally { if (response != null) { response.Close(); } }
    }
}
}
'@
    try { Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop; return $true }
    catch { $CockpitTlsSession.AddTypeError = @(($_.Exception.Message -split "`r?`n") | Where-Object { $_ })[0]; return $false }
}
function Invoke-CockpitHealthCSharp([int]$Port, [string]$Query, $TlsState, [int]$TimeoutMs) {
    Assert-CockpitHealthQuery $Query
    $answer = [OpencodeCockpit.PinnedHttp]::Get((Get-CockpitBaseUrl 'https' $Port), ('/api/health?' + $Query), $TlsState.Sha256Hex, $TimeoutMs)
    if ($answer[2] -cne '') {
        $failure = Get-CockpitFailureOf $answer[2]
        if (-not $failure) { $failure = 'Refus' }
        return (New-CockpitRaw 0 '' $failure ('{0} : {1}' -f $answer[2], (Hide-Secrets $answer[3])))
    }
    $blocking = @(Get-CockpitCertWarnings $TlsState | Where-Object { $_.Blocking })
    if ($blocking.Count -gt 0) { return (New-CockpitRaw 0 '' 'CertificatRefuse' $blocking[0].Text) }
    return (New-CockpitRaw ([int]$answer[0]) $answer[1] '' '')
}
# Voie HTTP native : aucun processus enfant, aucune compilation ; proxy retire sur la requete seulement.
function Invoke-CockpitHealthNative([int]$Port, [string]$Query, [int]$TimeoutMs) {
    Assert-CockpitHealthQuery $Query
    $response = $null
    try {
        $request = [System.Net.WebRequest]::Create((Get-CockpitBaseUrl 'http' $Port) + '/api/health?' + $Query)
        $request.Proxy = $null; $request.KeepAlive = $false; $request.AllowAutoRedirect = $false; $request.Timeout = $TimeoutMs; $request.ReadWriteTimeout = $TimeoutMs
        try { $response = $request.GetResponse() } catch {
            $web = $_.Exception
            while ($null -ne $web -and -not ($web -is [System.Net.WebException])) { $web = $web.InnerException }
            if ($null -eq $web) { return (New-CockpitRaw 0 '' 'VoieIndisponible' (Hide-Secrets $_.Exception.Message)) }
            if ($null -eq $web.Response) {
                $failure = Get-CockpitFailureOf ([string]$web.Status)
                if (-not $failure -or $failure -ceq 'CertificatRefuse') { $failure = 'VoieIndisponible' }
                return (New-CockpitRaw 0 '' $failure ('{0} : {1}' -f $web.Status, (Hide-Secrets $web.Message)))
            }
            $response = $web.Response
        }
        $reader = New-Object System.IO.StreamReader -ArgumentList $response.GetResponseStream(), ([System.Text.Encoding]::UTF8)
        $buffer = New-Object char[] 65536; $total = 0
        try { while ($total -lt $buffer.Length -and ($read = $reader.Read($buffer, $total, $buffer.Length - $total)) -gt 0) { $total += $read } }
        catch { return (New-CockpitRaw 0 '' 'Poignee' (Hide-Secrets $_.Exception.Message)) } finally { $reader.Dispose() }
        return (New-CockpitRaw ([int]$response.StatusCode) (New-Object string -ArgumentList $buffer, 0, $total) '' '')
    } finally { if ($null -ne $response) { $response.Close() } }
}
function New-CockpitHealth([string]$Reason, [string]$Detail, [string]$Method = '', [int]$Status = 0, [string]$Version = '', [string]$Ticket = '') {
    return [pscustomobject]@{ Reason = $Reason; Method = $Method; Status = $Status; Version = $Version; Detail = $Detail; Ticket = $Ticket; Retry = $false; TlsState = $null; ContainerHealth = '' }
}
# Classement commun d'une reponse (plan 3.7.5) : schema, version, preuve du jeton.
function ConvertTo-CockpitHealthResult([int]$Status, [string]$Body, $Mode, [string]$Token, [string]$Challenge) {
    $scheme = Get-CockpitSchemeOf $Mode
    $json = $null
    if ($Status -eq 200) { try { $json = ConvertFrom-Json $Body } catch { $json = $null } }
    if (-not ($json -is [System.Management.Automation.PSCustomObject])) { return (New-CockpitHealth 'Refus' ('reponse refusee (statut HTTP {0})' -f $Status) '' $Status) }
    $props = $json.PSObject.Properties
    # Version venue du reseau, affichee par les scripts : caracteres de version seulement, longueur bornee.
    $version = ''; if ($props['version']) { $version = [string]$json.version -replace '[^0-9A-Za-z.+-]', '' }; if ($version.Length -gt 32) { $version = $version.Substring(0, 32) }
    if (-not $props['scheme']) { return (New-CockpitHealth 'ImageAncienne' 'reponse sans schema (cockpit anterieur a 1.0.5)' '' $Status $version) }
    if ([string]$json.scheme -cne $scheme) { return (New-CockpitHealth 'SchemaDifferent' ('schema servi : {0}' -f ([string]$json.scheme -replace '[^a-z]', '')) '' $Status $version) }
    if ($version -cmatch '^([0-9]+)\.([0-9]+)\.([0-9]+)' -and [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3]) -lt [version]'1.0.5') { return (New-CockpitHealth 'ImageAncienne' ('version {0}' -f $version) '' $Status $version) }
    if ($props['proof'] -and $null -eq $json.proof) { return (New-CockpitHealth 'JetonHorsFormat' 'preuve non servie (jeton hors format)' '' $Status $version) }
    if (-not $props['proof'] -or [string]$json.proof -cne (Get-CockpitHmacHex $Token 'health-proof' $Challenge)) { return (New-CockpitHealth 'PreuveInvalide' 'preuve du jeton absente ou fausse' '' $Status $version) }
    $ticket = ''; if ($props['ticket'] -and $null -ne $json.ticket) { $ticket = [string]$json.ticket }
    return (New-CockpitHealth 'Ok' '' '' $Status $version $ticket)
}
# Premiere voie disponible (HTTPS : curl puis csharp ; HTTP : native puis curl, jamais Add-Type). Une raison definitive
# n'est jamais suivie d'une autre voie ; seule une voie indisponible passe la main.
function Test-CockpitHealth {
    param([int]$Port, $Mode, [string]$Token, $TlsState, [string[]]$Methods, [bool]$ContainerHealthy = $false, [switch]$WithTicket, [string]$CurlPath, [int]$TimeoutSec = 4)
    $scheme = Get-CockpitSchemeOf $Mode
    if (-not $Methods) { if ($scheme -ceq 'https') { $Methods = @('curl', 'csharp') } else { $Methods = @('native', 'curl') } }
    if ($scheme -ceq 'https' -and $null -eq $TlsState) { throw 'Certificat public requis pour verifier le cockpit en HTTPS.' }
    $challenge = New-CockpitChallenge; $query = 'challenge=' + $challenge
    # Demande de ticket signee (le serveur n'en emet pas sans elle) ; jamais pour un jeton hors format, qui n'en obtient pas.
    if ($WithTicket -and (Test-CockpitGeneratedToken $Token)) { $query += '&ticket=' + (Get-CockpitHmacHex $Token 'auth-ticket-request' $challenge) }
    $unavailable = @(); $curlReason = $null
    foreach ($method in $Methods) {
        if ($method -ceq 'curl') {
            $curl = Get-CockpitCurl $CurlPath
            $curlReason = $curl.Reason
            if (-not $curl.Available) { $unavailable += ('curl.exe : ' + $curl.Reason); continue }
            $raw = Invoke-CockpitHealthCurl $scheme $Port $query $TlsState $curl.Path $TimeoutSec
        } elseif ($method -ceq 'csharp' -and $scheme -ceq 'https') {
            if ($null -eq $curlReason) { $curlReason = (Get-CockpitCurl $CurlPath).Reason; if (-not $curlReason) { $curlReason = 'voie non retenue' } }
            if (-not (Initialize-CockpitPinnedHttp $curlReason)) { $unavailable += ('classe .NET : ' + $CockpitTlsSession.AddTypeError); continue }
            $raw = Invoke-CockpitHealthCSharp $Port $query $TlsState ($TimeoutSec * 1000)
        } elseif ($method -ceq 'native' -and $scheme -ceq 'http') {
            $raw = Invoke-CockpitHealthNative $Port $query ($TimeoutSec * 1000)
            if ($raw.Failure -ceq 'VoieIndisponible') { $unavailable += ('HttpWebRequest : ' + $raw.Detail); continue }
        } else { throw ('Voie de verification non autorisee en {0} : {1}' -f $scheme, $method) }
        if ($raw.Failure) { $health = New-CockpitHealth $raw.Failure $raw.Detail '' $raw.Status } else { $health = ConvertTo-CockpitHealthResult $raw.Status $raw.Body $scheme $Token $challenge }
        $health.Method = $method
        $health.Retry = ($health.Reason -ceq 'NonDisponible') -or ((@('Poignee', 'PreuveInvalide') -contains $health.Reason) -and -not $ContainerHealthy)
        return $health
    }
    return (New-CockpitHealth 'AucuneVoie' ($unavailable -join ' ; '))
}
# Reessais (plan 3.7.5) : NonDisponible jusqu'au delai ; Poignee et PreuveInvalide tant que le conteneur n'est pas healthy
# (Poignee apres healthy : schema servi compare) ; EmpreinteDifferente : une relecture puis un essai. Root vide : sans docker.
function Wait-CockpitHealth {
    param([string]$Root, [int]$Port, $Mode, [string]$Token, [int]$TimeoutSec = 240, [string[]]$Methods, [string]$CurlPath, [int]$PollSec = 2, $TlsState)
    $scheme = Get-CockpitSchemeOf $Mode
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $state = $TlsState; $reread = $false; $last = $null
    while ($true) {
        $container = ''; $health = $null
        if ($Root) { $container = Get-CockpitContainerHealth $Root }
        if ($Root -and $scheme -ceq 'https') {
            try { $state = Read-CockpitTlsPublic $Root } catch { $state = $null; $health = New-CockpitHealth 'Refus' $_.Exception.Message; $health.Retry = ($container -cne 'healthy') }
        }
        if ($null -eq $health -and $scheme -ceq 'https' -and $null -eq $state) { $health = New-CockpitHealth 'NonDisponible' 'certificat public pas encore publie'; $health.Retry = $true }
        if ($null -eq $health) {
            # Aucune tentative a moins de 0,5 s de l'echeance ; delai de chaque tentative borne au temps restant (echeance tenue a 1 s pres).
            $remaining = ($deadline - (Get-Date)).TotalSeconds
            if ($null -ne $last -and $remaining -le 0.5) { return $last }
            $health = Test-CockpitHealth -Port $Port -Mode $scheme -Token $Token -TlsState $state -Methods $Methods -ContainerHealthy ($container -ceq 'healthy') -CurlPath $CurlPath -TimeoutSec ([Math]::Max(1, [Math]::Min(4, [int][Math]::Floor($remaining))))
            if ($health.Reason -ceq 'EmpreinteDifferente' -and $Root -and -not $reread) { $reread = $true; continue }
            if ($health.Reason -ceq 'Poignee' -and $container -ceq 'healthy') {
                $served = Get-CockpitServedScheme $Root
                if ($served -and $served -cne $scheme) { $health.Reason = 'SchemaDifferent'; $health.Detail = 'schema servi : ' + ($served -replace '[^a-z]', '') } else { $health.Reason = 'Refus' }
            }
        }
        $health.TlsState = $state; $health.ContainerHealth = $container
        $left = ($deadline - (Get-Date)).TotalMilliseconds
        if (-not $health.Retry -or $left -le 0) { return $health }
        $last = $health
        Start-Sleep -Milliseconds ([int][Math]::Min($PollSec * 1000, $left))
    }
}
# [Q7] Ticket demande par la meme voie apres une nouvelle preuve du jeton ; l'URL n'est jamais affichee.
function Get-CockpitLoginUrl {
    param($Health, [int]$Port, $Mode, [string]$Token, $TlsState, [string]$CurlPath)
    $scheme = Get-CockpitSchemeOf $Mode
    $result = [pscustomobject]@{ Url = $null; Reason = 'SanteNonOk'; Detail = '' }
    if ($null -eq $Health -or $Health.Reason -cne 'Ok') { return $result }
    if ($null -eq $TlsState) { $TlsState = $Health.TlsState }
    $again = Test-CockpitHealth -Port $Port -Mode $scheme -Token $Token -TlsState $TlsState -Methods @($Health.Method) -ContainerHealthy $true -WithTicket -CurlPath $CurlPath
    $result.Reason = $again.Reason; $result.Detail = $again.Detail
    if ($again.Reason -ceq 'Ok' -and $again.Ticket -cnotmatch '^[0-9a-f]{64}\z') { $result.Reason = 'TicketInvalide'; $result.Detail = 'ticket de connexion absent ou mal forme' }
    elseif ($again.Reason -ceq 'Ok') { $result.Url = (Get-CockpitBaseUrl $scheme $Port) + '/auth?k=' + $again.Ticket + '.' + (Get-CockpitHmacHex $Token 'auth-ticket' $again.Ticket) }
    return $result
}

# --- Poste gere : strategies du navigateur (annexe B ; le registre n'est qu'un indice, edge://policy fait foi) --------
function Read-CockpitPolicyValue($Roots, [string]$SubKey, [string]$Name) {
    foreach ($source in @($Roots.Keys)) {
        $key = [string]$Roots[$source] + '\' + $SubKey
        $item = $null
        if (Test-Path -LiteralPath $key) { $item = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue }
        if ($null -ne $item -and $item.PSObject.Properties[$Name]) { return [pscustomobject]@{ Value = $item.$Name; Source = $source } }
    }
    return [pscustomobject]@{ Value = $null; Source = $null }
}
# Verdict Edge : Autorise (absente ou 1), Couvert (0 + origine couverte), Bloque (0, origines reconnues sans couverture), AVerifier.
function Get-CockpitBrowserTlsPolicy {
    param([int]$Port = 7777, $RegistryRoots)
    if ($null -eq $RegistryRoots) { $RegistryRoots = [ordered]@{ HKLM = 'HKLM:\SOFTWARE\Policies'; HKCU = 'HKCU:\SOFTWARE\Policies' } }
    $origin = Get-CockpitBaseUrl 'https' $Port
    $edge = Read-CockpitPolicyValue $RegistryRoots 'Microsoft\Edge' 'SSLErrorOverrideAllowed'
    $policy = [pscustomobject]@{ Verdict = 'Autorise'; Source = $edge.Source; Value = $edge.Value; Origins = @(); Origin = $origin; Port = $Port
        Chrome = (Read-CockpitPolicyValue $RegistryRoots 'Google\Chrome' 'SSLErrorOverrideAllowed')
        HttpsOnly = @(foreach ($name in @('HttpsOnlyMode', 'AutomaticHttpsDefault', 'HttpsUpgradesEnabled')) { $read = Read-CockpitPolicyValue $RegistryRoots 'Microsoft\Edge' $name; if ($null -ne $read.Value) { [pscustomobject]@{ Name = $name; Value = [string]$read.Value; Source = $read.Source } } }) }
    if ($null -eq $edge.Value -or [string]$edge.Value -ceq '1') { return $policy }
    $policy.Verdict = 'AVerifier'
    if ([string]$edge.Value -cne '0') { return $policy }
    $listKey = [string]$RegistryRoots[$edge.Source] + '\Microsoft\Edge\SSLErrorOverrideAllowedForOrigins'
    $item = $null
    if (Test-Path -LiteralPath $listKey) { $item = Get-ItemProperty -LiteralPath $listKey -ErrorAction SilentlyContinue }
    if ($null -ne $item) { $policy.Origins = @($item.PSObject.Properties | Where-Object { $_.Name -cmatch '^[0-9]+\z' } | Sort-Object { [int]$_.Name } | ForEach-Object { [string]$_.Value }) }
    $normalized = @($policy.Origins | ForEach-Object { $_.Trim().ToLowerInvariant().TrimEnd('/') })
    if ($normalized -ccontains $origin -or $normalized -ccontains $origin.Substring(0, $origin.LastIndexOf(':'))) { $policy.Verdict = 'Couvert' }
    elseif (@($normalized | Where-Object { $_ -cnotmatch '^https?://([a-z0-9-]+(\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(:[0-9]{1,5})?\z' }).Count -eq 0) { $policy.Verdict = 'Bloque' }
    return $policy
}
function Format-CockpitEdgePolicyValue($Policy) { if ($null -eq $Policy -or $null -eq $Policy.Value) { return 'absente' }; return [string]$Policy.Value }
function Get-CockpitPortOwner([int]$Port) {
    try {
        $names = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } | ForEach-Object { $_.ProcessName } | Sort-Object -Unique)
        if ($names.Count -gt 0) { return ($names -join ', ') }
    } catch { }
    return 'inconnu'
}

# --- Decisions pures et messages (annexe A) ------------------------------------------------------------------------
function New-CockpitLines([string]$Code, [string[]]$Lines) { return [pscustomobject]@{ Code = $Code; Lines = $Lines } }
function Write-CockpitLines([string[]]$Lines) {
    foreach ($line in $Lines) {
        $color = @(@('[!]', 'Yellow'), @('[OK]', 'Green'), @('==>', 'Cyan') | Where-Object { $line.TrimStart().StartsWith($_[0]) })
        if ($color.Count -gt 0) { Write-Host $line -ForegroundColor $color[0][1] } else { Write-Host $line }
    }
}
# Pure : Open si et seulement si Reason = Ok. En HTTPS, A2-Open (strategie Bloque) sans bloquer ; en HTTP, strategie ignoree.
function Get-CockpitOpenDecision($Health, $Mode, $Policy) {
    if ($null -eq $Health -or $Health.Reason -cne 'Ok') { return [pscustomobject]@{ Decision = 'NotOk'; Lines = @() } }
    $lines = @(); $verdict = ''
    if ((Get-CockpitSchemeOf $Mode) -ceq 'https' -and $null -ne $Policy) { $verdict = [string]$Policy.Verdict }
    if ($verdict -ceq 'Bloque') { $lines = @(("    [!] Strategie Edge lue : passage de l'avertissement interdit pour {0} (edge://policy fait foi)." -f $Policy.Origin), "    Le lien s'ouvre quand meme. Si Edge ne propose pas `"Continuer`" : .\cockpit.ps1 diag") }
    elseif ($verdict -ceq 'AVerifier') { $lines = @('    [!] Strategie Edge lue : exception de forme non reconnue -> verifiez edge://policy (filtre SSLError).') }
    return [pscustomobject]@{ Decision = 'Open'; Lines = $lines }
}
# Pure : table du plan 3.4.1. Migration = .env existant avec COCKPIT_VERSION absent ou < 1.0.5.
function Get-CockpitTransition {
    param($Mode, [bool]$IsNew, [bool]$IsMigration, [switch]$Http, [switch]$Https)
    if ($Http -and $Https) { throw '-Http et -Https sont incompatibles.' }
    $valid = [bool]$Mode.Valid
    if ($Http) { if ($valid -and [string]$Mode.Scheme -ceq 'http') { return 'ResteHttp' } else { return 'EntreeHttp' } }
    if ($Https -and -not ($valid -and [string]$Mode.Scheme -ceq 'https')) { return 'EntreeHttps' }
    if (-not $valid) { return 'Invalide' }
    if ([string]$Mode.Scheme -ceq 'http' -and -not $Https) { return 'ResteHttp' }
    if ($IsNew -or $IsMigration -or [string]$Mode.Scheme -ceq 'http') { return 'EntreeHttps' }
    return 'ResteHttps'
}
# Pure : bloc de pre-controles (plan 3.5.1). La garde Edge ne bloque qu'une entree en HTTPS, jamais un passage en HTTP.
function Get-CockpitPrecheckProblems {
    param([string]$Transition, $Mode, $Policy, [bool]$AcceptBrowserBlock, [bool]$IsMigration, [string]$LoadProblem, [int]$Port, [string]$Version, [string]$PreviousVersion)
    $problems = @(); $warnings = @()
    $origin = Get-CockpitBaseUrl 'https' $Port
    $verdict = ''; $source = 'registre'
    if ($null -ne $Policy) { $verdict = [string]$Policy.Verdict; if ($Policy.Source) { $source = [string]$Policy.Source } }
    $previous = $PreviousVersion; if (-not $previous) { $previous = 'version precedente' }
    $entry = $Transition -ceq 'EntreeHttps'
    $blocked = $entry -and $verdict -ceq 'Bloque' -and -not $AcceptBrowserBlock
    if ($Transition -ceq 'Invalide') {
        $problem = 'valeur non reconnue'
        if ($null -ne $Mode -and $Mode.Problem) { $problem = [string]$Mode.Problem }
        $problems += New-CockpitLines 'A18' @(("    [!] Mode d'acces invalide dans .env : {0}." -f $problem), '    Aucune modification. Choisissez : .\install.ps1 -Https (recommande) ou .\install.ps1 -Http (confirmation demandee).')
    } elseif ($blocked) {
        $problems += New-CockpitLines 'A2' @("    [!] Edge interdit de passer l'avertissement de certificat sur ce poste", ('        (strategie SSLErrorOverrideAllowed = 0 lue dans {0}, aucune exception pour {1}).' -f $source, $origin),
            "    [!] En HTTPS, le cockpit serait inaccessible dans Edge. Rien n'a ete modifie :", '        .env, images et conteneurs sont inchanges ; votre cockpit actuel continue de tourner.', '    Deux issues :',
            ("      1. Demander a l'informatique l'exception Edge SSLErrorOverrideAllowedForOrigins = {0}," -f $origin), '         puis relancer : .\install.ps1',
            '      2. Choisir le mode HTTP local (trafic non chiffre sur ce PC, confirmation demandee) :', '         .\install.ps1 -Http',
            '    Verification qui fait foi : edge://policy (filtre SSLError). Si Edge y autorise bien "Continuer"', '    (lecture du registre erronee) : .\install.ps1 -AcceptBrowserBlock')
    }
    if ($LoadProblem) {
        $problems += New-CockpitLines 'A-Load' @(('    [!] Mode Load : {0}.' -f $LoadProblem), ('    Telechargez opencode-cockpit-images-{0}.tar.gz (page Releases), puis relancez avec' -f $Version), '    -Mode Load -ImagesArchive <fichier>   (ou -Mode Pull si ghcr.io est joignable)')
        if ($blocked) { $problems += New-CockpitLines 'A2-Load' @(("    Mode Load : quelle que soit l'issue choisie, ajoutez -ImagesArchive <opencode-cockpit-images-{0}.tar.gz> a la commande." -f $Version)) }
    }
    if ($problems.Count -gt 0 -and $IsMigration) {
        $problems += New-CockpitLines 'A2-Update' @(('    Si vous venez de lancer .\cockpit.ps1 update : les scripts sont deja en {0}, mais vos conteneurs sont' -f $Version),
            ('    restes en {0} et fonctionnent toujours sur {1} (favoris et sessions ouvertes valables).' -f $previous, (Get-CockpitBaseUrl 'http' $Port)), ('    Pour retrouver les scripts {0} en attendant : .\cockpit.ps1 rollback' -f $previous))
    }
    if ($verdict -ceq 'Bloque' -and $Transition -ceq 'ResteHttps') {
        $warnings += New-CockpitLines 'A2-Reste' @(('    [!] Strategie Edge lue : SSLErrorOverrideAllowed = 0 ({0}), aucune exception pour {1}.' -f $source, $origin),
            "    Votre cockpit est deja en HTTPS : la mise a jour continue. S'il s'ouvre bien dans Edge (exception livree", '    autrement, par exemple par le cloud), ignorez ce message ; sinon : .\cockpit.ps1 diag')
    } elseif ($verdict -ceq 'Bloque' -and $entry -and $AcceptBrowserBlock) { $warnings += New-CockpitLines 'AcceptBrowserBlock' @(('    [!] Strategie Edge lue : SSLErrorOverrideAllowed = 0 ({0}), aucune exception pour {1} : ignoree (-AcceptBrowserBlock).' -f $source, $origin))
    } elseif ($verdict -ceq 'AVerifier' -and ($entry -or $Transition -ceq 'ResteHttps')) { $warnings += New-CockpitLines 'AVerifier' @('    [!] Strategie Edge lue : exception de forme non reconnue -> verifiez edge://policy (filtre SSLError).')
    } elseif ($verdict -ceq 'Couvert' -and $entry) { $warnings += New-CockpitLines 'Couvert' @(('    Strategie Edge lue : exception {0} en place (edge://policy fait foi).' -f $origin)) }
    # Arret (plan 3.5.1, point 6) : aucun avertissement, A2-Reste ("la mise a jour continue") contredirait A19.
    return [pscustomobject]@{ Problems = $problems; Warnings = @($warnings | Where-Object { $problems.Count -eq 0 }) }
}
# A6 (install), A6-1 (-OneLine, cockpit.ps1), A6b (strategie Autorise ou Couvert).
function Write-CockpitModeNotice($Mode, $Policy, [switch]$OneLine) {
    $at = [string]$Mode.ConfirmedAt
    if ($at -cmatch '^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2})') { $at = $Matches[1] + ' ' + $Matches[2] }
    if ($OneLine) { Write-CockpitLines @(('[!] Mode HTTP local (confirme le {0} UTC) : trafic en clair sur ce PC. Revenir en HTTPS, si Edge le permet : .\install.ps1 -Https' -f $at)); return }
    Write-CockpitLines @(('    [!] MODE HTTP LOCAL (confirme le {0} UTC avec -Http)' -f $at), '    [!] Cookie de session et contenu des pages en clair sur ce PC ; serveur non identifie par certificat.', '    [!] Revenir en HTTPS, si Edge le permet : .\install.ps1 -Https')
    if ($null -ne $Policy -and @('Autorise', 'Couvert') -contains [string]$Policy.Verdict) {
        Write-CockpitLines @(("    Edge semble autoriser le passage de l'avertissement (ou l'exception {0} est en place) :" -f $Policy.Origin), '    le mode HTTPS est probablement utilisable. Verifiez edge://policy, puis : .\install.ps1 -Https')
    }
}
# A5 puis la seule question du mode HTTP : rend sans rien si la phrase exacte est tapee, leve une exception sinon.
function Confirm-CockpitHttpMode([int]$Port, $Policy) {
    $origin = Get-CockpitBaseUrl 'https' $Port
    $verdict = ''; $source = 'registre'
    if ($null -ne $Policy) { $verdict = [string]$Policy.Verdict; if ($Policy.Source) { $source = [string]$Policy.Source } }
    $policyLine = '    Strategie Edge lue : exception de forme non reconnue -> verifiez edge://policy (filtre SSLError).'
    if ($verdict -ceq 'Bloque') { $policyLine = ('    Strategie Edge lue : SSLErrorOverrideAllowed = 0 ({0}), aucune exception pour {1} -> HTTPS serait bloque dans Edge (edge://policy fait foi).' -f $source, $origin) }
    elseif ($verdict -ceq 'Couvert') { $policyLine = ('    Strategie Edge lue : exception {0} en place -> HTTPS devrait fonctionner : le mode HTTP est-il vraiment necessaire ?' -f $origin) }
    elseif ($verdict -ceq 'Autorise') { $policyLine = '    Strategie Edge lue : aucune strategie bloquante trouvee -> HTTPS devrait fonctionner (edge://policy fait foi).' }
    Write-Host ''
    Write-CockpitLines @('==> Mode HTTP local demande (-Http)', ('    [!] Le cockpit sera servi en {0} au lieu de https.' -f (Get-CockpitBaseUrl 'http' $Port)),
        '    [!] Ce qui circule EN CLAIR entre le navigateur et le cockpit, sur ce PC :', '        - le cookie de session (il donne acces au cockpit pendant 30 jours) ;',
        '        - tout le contenu des pages : conversations, code, reponses, code de connexion GitHub affiche.', '    [!] Qui peut le lire :',
        '        - les outils de securite du poste qui inspectent le trafic (EDR, DLP, protection web) :', '          ils peuvent enregistrer les adresses completes et les cookies ;',
        '        - un programme lance avec les droits administrateur ;', '        - tout compte qui peut piloter Docker Desktop (groupe docker-users) : le trafic traverse',
        '          la machine virtuelle et le reseau de Docker.', "    [!] Aucun certificat n'identifie le serveur : .\cockpit.ps1 open verifie qu'il connait le jeton",
        "        avant d'ouvrir le lien. Ne saisissez jamais le jeton dans une page : l'ecran de connexion ne le demande pas.",
        '    Ce qui ne change pas : ecoute sur 127.0.0.1 uniquement, jeton de 256 bits, cookie __Host-, controle de', "    l'hote et de l'origine, CSP ; le trafic vers GitHub Copilot reste chiffre.",
        $policyLine, '    Ce choix est memorise dans .env et garde par chaque mise a jour ; un bandeau permanent le rappelle.', '    Revenir en HTTPS plus tard, si Edge le permet : .\install.ps1 -Https (nouveau jeton, reconnexion).')
    try { $answer = Read-Host 'Tapez HTTP EN CLAIR pour confirmer (toute autre reponse annule sans rien modifier)' -ErrorAction Stop }
    catch {
        if ($_.Exception -is [System.Management.Automation.PSInvalidOperationException]) { throw 'Installation annulee : la confirmation du mode HTTP exige une console interactive (tapez HTTP EN CLAIR).' }
        throw
    }
    if ([string]$answer -cne 'HTTP EN CLAIR') { throw 'Installation annulee : mode HTTP non confirme. Aucun fichier modifie, mode inchange.' }
}
