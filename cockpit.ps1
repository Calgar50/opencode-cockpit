<#
.SYNOPSIS
    Pilotage quotidien d'opencode-cockpit.

.DESCRIPTION
    .\cockpit.ps1 open                  Verifie le cockpit (certificat et preuve du jeton) puis ouvre l'interface
    .\cockpit.ps1 start | stop          Demarre (en appliquant .env) ou arrete les conteneurs
    .\cockpit.ps1 restart               Recree les conteneurs (relit .env et certs\)
    .\cockpit.ps1 status                Etat des conteneurs et du cockpit
    .\cockpit.ps1 logs [opencode|cockpit]
    .\cockpit.ps1 diag                  Diagnostic en lecture seule : conteneurs, acces a l interface, reseau, journal
    .\cockpit.ps1 tls [-Renew]          Certificat HTTPS local (-Renew : nouveau certificat, confirmation demandee)
    .\cockpit.ps1 certs                 Reexporte les certificats Windows puis recree les conteneurs
    .\cockpit.ps1 update                git pull puis relance install.ps1 (meme mode d'installation et d'acces)
    .\cockpit.ps1 rollback              Revient a la version precedente (confirmation demandee)
    .\cockpit.ps1 backup                Sauvegarde reglages, couts, archives et configuration opencode
    .\cockpit.ps1 restore <fichier>     Restaure une sauvegarde (remplace les donnees actuelles)
    .\cockpit.ps1 uninstall [-Purge [-PurgeOmo]]
                                        Supprime les conteneurs (-Purge : donnees et images du cockpit ;
                                        -PurgeOmo en plus : image, volumes et configuration de la salle)
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('open', 'start', 'stop', 'restart', 'status', 'logs', 'diag', 'certs', 'update', 'backup', 'restore', 'uninstall', 'help', 'tls', 'rollback')]
    [string]$Command = 'help',
    # Service pour 'logs' (opencode ou cockpit), ou fichier de sauvegarde pour 'restore'.
    [Parameter(Position = 1)]
    [string]$Target = '',
    [switch]$Purge,
    # 'uninstall -Purge -PurgeOmo' : supprime aussi l'image de la salle, ses volumes et sa configuration figee.
    [switch]$PurgeOmo,
    # 'tls -Renew' : efface le certificat local pour en creer un nouveau au demarrage suivant.
    [switch]$Renew
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = $PSScriptRoot
$EnvFile = Join-Path $Root '.env'
$Version = 'dev'
$VersionFile = Join-Path $Root 'VERSION'
if (Test-Path -LiteralPath $VersionFile) { $Version = (Get-Content -LiteralPath $VersionFile -TotalCount 1).Trim() }

# Bibliotheque commune a install.ps1 et cockpit.ps1 : isolation de docker compose, verification du cockpit, messages.
$LibraryFile = Join-Path $Root 'CockpitTls.ps1'
if (-not (Test-Path -LiteralPath $LibraryFile -PathType Leaf)) {
    throw 'Fichiers de la version incomplets : CockpitTls.ps1 est absent du dossier du cockpit. Recuperez la version complete (git pull, ou archive de la page Releases), puis relancez.'
}
try { . $LibraryFile } catch {
    $blocked = $false
    try { $blocked = $null -ne (Get-Item -LiteralPath $LibraryFile -Stream 'Zone.Identifier' -ErrorAction SilentlyContinue) } catch { }
    if ($blocked) { throw 'Fichiers telecharges bloques par Windows. Dans le dossier du cockpit : Unblock-File .\install.ps1, .\cockpit.ps1, .\CockpitTls.ps1, puis relancez.' }
    throw
}
Assert-CockpitFullLanguage

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Attention([string]$Message) { Write-Host "[!] $Message" -ForegroundColor Yellow }

# Volumes nommes de docker-compose.yml (cockpit) et de la salle (docker\opencode-omo\contrat-salle.json, cle volumes) :
# 'uninstall -Purge' n'efface que les premiers ; les seconds portent les conversations de la salle et sa configuration
# figee, et ne partent qu'avec -PurgeOmo (decision du 17/09 n. 3). Egalite verifiee par tests\ps51\Test-Cockpit.ps1.
$CockpitVolumes = @('oc-config', 'oc-data', 'oc-cache', 'cockpit-data', 'cockpit-tls', 'control')
$OmoVolumes = @('control-omo', 'omo-auth', 'omo-state', 'egress-log', 'oc-omo-data', 'omo-config', 'omo-carnets')
# Volume des conversations de la salle : sauvegarde comme oc-data, sans jamais son auth.json.
$OmoDataVolume = 'oc-omo-data'

# Nom du projet tel que docker compose le resout : lu une seule fois, seulement quand une commande en a besoin.
$ProjectName = $null
function Get-Project {
    if (-not $ProjectName) { $script:ProjectName = Get-CockpitComposeProjectName $Root }
    return $ProjectName
}

# Fonction simple, sans bloc param : un attribut [Parameter()] ajouterait les parametres communs de
# PowerShell, et des options docker comme -v ou -d seraient prises pour -Verbose ou -Debug.
# Variables lues par compose masquees le temps de l'appel, fichier compose explicite (plan 3.3).
function Invoke-Docker {
    $dockerArgs = ConvertTo-CockpitDockerArgs $Root @($args)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $savedEnv = Clear-CockpitComposeEnv
    try { & docker @dockerArgs } finally { $ErrorActionPreference = $previous; Restore-CockpitComposeEnv $savedEnv }
    if ($LASTEXITCODE -ne 0) { throw ("La commande 'docker {0}' a echoue (code {1})." -f ($dockerArgs -join ' '), $LASTEXITCODE) }
}

# Commande docker avec delai maximal : un conteneur bloque au demarrage ne doit pas figer le diagnostic.
# Premier argument : delai en secondes ; les suivants sont passes a docker.
function Invoke-DockerTimeout {
    $seconds = [int]$args[0]
    $result = Invoke-CockpitDocker $Root @($args | Select-Object -Skip 1) $seconds
    return [pscustomobject]@{ TimedOut = $result.TimedOut; ExitCode = $result.ExitCode; Output = ($result.StdOut + $result.StdErr).Trim() }
}

function Get-EnvValue([string]$Key) {
    if (-not (Test-Path -LiteralPath $EnvFile)) { throw 'Fichier .env introuvable : lancez d abord .\install.ps1' }
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
        if ($line -match ('^\s*{0}=(.*)$' -f [regex]::Escape($Key))) { return $Matches[1].Trim() }
    }
    return ''
}

# Toutes les cles de .env, dans l'ordre du fichier (meme lecture que install.ps1).
function Read-CockpitEnv {
    if (-not (Test-Path -LiteralPath $EnvFile)) { throw 'Fichier .env introuvable : lancez d abord .\install.ps1' }
    $values = [ordered]@{}
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $index = $line.IndexOf('=')
        $values[$line.Substring(0, $index).Trim()] = $line.Substring($index + 1).Trim()
    }
    return $values
}

# Reecriture ciblee de quelques cles : toutes les autres lignes de .env sont conservees telles quelles.
function Update-CockpitEnvKeys($Values) {
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) { $lines.Add($line) }
    foreach ($key in @($Values.Keys)) {
        $done = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match ('^\s*{0}=' -f [regex]::Escape($key))) { $lines[$i] = ('{0}={1}' -f $key, $Values[$key]); $done = $true; break }
        }
        if (-not $done) { $lines.Add(('{0}={1}' -f $key, $Values[$key])) }
    }
    [System.IO.File]::WriteAllText($EnvFile, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
}

# Chemin absolu normalise, sans barre finale ('C:' designe la racine du lecteur, pas son dossier courant).
function Get-NormalizedPath([string]$Path) {
    $candidate = $Path.Trim().Trim('"').Replace('/', '\')
    if ($candidate -match '^[A-Za-z]:$') { $candidate += '\' }
    # Chemin relatif de .env : docker compose le lit depuis le dossier du cockpit.
    if (-not [System.IO.Path]::IsPathRooted($candidate)) { $candidate = Join-Path $Root $candidate }
    return [System.IO.Path]::GetFullPath($candidate).TrimEnd('\')
}

# Le dossier du cockpit (scripts, docker-compose.yml, .env, certs\) ne doit jamais etre monte dans le conteneur de l'agent.
function Assert-CockpitOutsideWorkspace {
    $workspace = Get-EnvValue 'WORKSPACE_DIR'
    if (-not $workspace) { return }
    $a = Get-NormalizedPath $Root
    $b = Get-NormalizedPath $workspace
    $ignoreCase = [System.StringComparison]::OrdinalIgnoreCase
    if (($a -ieq $b) -or $a.StartsWith($b + '\', $ignoreCase) -or $b.StartsWith($a + '\', $ignoreCase)) {
        throw ("Le dossier du cockpit ({0}) et le dossier des projets ({1}, WORKSPACE_DIR) se chevauchent : l'agent pourrait modifier cockpit.ps1, install.ps1, docker-compose.yml, .env ou certs. Deplacez le dossier du cockpit hors du dossier des projets (avec .env, certs, archives et backups), puis relancez .\install.ps1." -f $a, $b)
    }
}

function Get-Port {
    $value = Get-EnvValue 'COCKPIT_PORT'
    if ($value) { return [int]$value }
    return 7777
}

function Get-ArchiveDir {
    # Dossier reellement monte sur /archives, tel que compose le resout (guillemets, ~, chemin relatif).
    # La configuration contient des secrets : elle reste en memoire et n'est jamais affichee.
    $result = Invoke-CockpitDocker $Root @('compose', 'config', '--format', 'json') 60
    if ($result.ExitCode -ne 0 -or -not $result.StdOut) { throw 'Lecture de la configuration impossible (docker compose config).' }
    $mount = @((ConvertFrom-Json $result.StdOut).services.cockpit.volumes | Where-Object { $_.target -eq '/archives' }) | Select-Object -First 1
    if ($null -eq $mount) { throw 'Montage /archives introuvable dans docker-compose.yml.' }
    New-Item -ItemType Directory -Path $mount.source -Force | Out-Null
    return (Resolve-Path -LiteralPath $mount.source).Path
}

# --- Mode d'acces, etat du cockpit et messages (plan 3.9, annexe A) --------------------------------------------------

function Get-AccessMode { return (Get-CockpitLocalMode (Read-CockpitEnv)) }

function Get-CockpitVersionOrNull([string]$Text) {
    if ([string]$Text -cmatch '^([0-9]+)\.([0-9]+)\.([0-9]+)') { return [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3]) }
    return $null
}

function Get-CockpitMethodLabel([string]$Method) {
    if ($Method -ceq 'curl') { return 'curl' }
    if ($Method -ceq 'csharp') { return 'classe .NET' }
    if ($Method -ceq 'native') { return 'HttpWebRequest' }
    return 'aucune'
}

# Sante du cockpit (certificat epingle en HTTPS, preuve du jeton dans les deux modes) : 5 s par defaut.
# -Methods vide : voies du plan 3.11 (HTTPS : curl, puis classe .NET en dernier recours ; HTTP : HttpWebRequest, puis curl).
function Get-CockpitHealth($Mode, [int]$Port, [int]$TimeoutSec = 5, [string[]]$Methods = @()) {
    return (Wait-CockpitHealth -Root $Root -Port $Port -Mode $Mode -Token (Get-EnvValue 'COCKPIT_TOKEN') -TimeoutSec $TimeoutSec -Methods $Methods)
}

# Version de l'IMAGE du conteneur cockpit en marche ($null si absent ou illisible) : jamais l'environnement du conteneur,
# qui contient le jeton. Une version anterieure a 1.0.5 signale une mise a jour inachevee (plan 3.8.3).
function Get-RunningImageVersion {
    $ps = Invoke-CockpitDocker $Root @('compose', 'ps', '-q', 'cockpit') 20
    $ids = @(($ps.StdOut -split "`r?`n") | Where-Object { $_ -cmatch '^[0-9a-f]{12,64}\z' })
    if ($ps.ExitCode -ne 0 -or $ids.Count -eq 0) { return $null }
    $inspect = Invoke-CockpitDocker $Root @('inspect', '--format', '{{.Image}}', $ids[0]) 20
    if ($inspect.ExitCode -ne 0) { return $null }
    $image = $inspect.StdOut.Trim()
    if (-not $image) { return $null }
    return (Get-CockpitImageVersion $image)
}

function Test-CockpitUnfinishedUpdate($ImageVersion) { return ($null -ne $ImageVersion -and $ImageVersion -lt [version]'1.0.5') }

function Write-CockpitA18($Mode) {
    $problem = 'valeur non reconnue'
    if ($null -ne $Mode -and $Mode.Problem) { $problem = [string]$Mode.Problem }
    Write-CockpitLines @(("    [!] Mode d'acces invalide dans .env : {0}." -f $problem),
        '    Aucune modification. Choisissez : .\install.ps1 -Https (recommande) ou .\install.ps1 -Http (confirmation demandee).')
}

# A10 : mise a jour inachevee (scripts 1.0.5, conteneurs anterieurs). Le cockpit en place fonctionne toujours (K2-3).
function Write-CockpitA10($ImageVersion, [int]$Port) {
    $image = 'anterieure a 1.0.5'
    if ($ImageVersion) { $image = [string]$ImageVersion }
    $lines = @(('    [!] Mise a jour inachevee : les scripts sont en {0}, le cockpit en marche est en {1}.' -f $Version, $image),
        ('    Votre cockpit {0} fonctionne toujours sur {1} : utilisez votre favori' -f $image, (Get-CockpitBaseUrl 'http' $Port)),
        '    ou un onglet deja connecte. A defaut : .\cockpit.ps1 rollback, puis .\cockpit.ps1 open.',
        ("    .\cockpit.ps1 open n'ouvre rien ici : il ne sait pas verifier un cockpit {0}." -f $image),
        '    Terminer la mise a jour : .\install.ps1 (HTTPS) ou .\install.ps1 -Http (mode HTTP local)')
    if ((Get-EnvValue 'COCKPIT_INSTALL_MODE') -ceq 'Load') { $lines += ('    Mode Load : ajoutez -Mode Load -ImagesArchive <opencode-cockpit-images-{0}.tar.gz>' -f $Version) }
    Write-CockpitLines $lines
}

function Write-CockpitA10Short($ImageVersion) {
    $image = 'anterieure a 1.0.5'
    if ($ImageVersion) { $image = [string]$ImageVersion }
    Write-CockpitLines @(('[!] Mise a jour inachevee (scripts {0}, cockpit {1}) : le cockpit {1} est demarre. Terminer : .\install.ps1 ; revenir : .\cockpit.ps1 rollback' -f $Version, $image))
}

# Cause d'un schema servi different de .env : noms des variables et fichiers voisins, jamais les valeurs (plan 3.3).
function Get-CockpitDivergenceText {
    $divergence = Get-CockpitComposeDivergence $Root
    $scopes = @{ 'Process' = 'Processus'; 'User' = 'Utilisateur'; 'Machine' = 'Machine' }
    if (@($divergence.Variables).Count -gt 0) {
        $names = (@($divergence.Variables | ForEach-Object { [string]$_.Name } | Sort-Object -Unique) -join ', ')
        $where = (@($divergence.Variables | ForEach-Object { [string]$scopes[[string]$_.Scope] } | Where-Object { $_ } | Sort-Object -Unique) -join ', ')
        return ('variable(s) {0} definie(s) ({1})' -f $names, $where)
    }
    if (@($divergence.Files).Count -gt 0) { return ('fichier {0} dans le dossier du cockpit' -f (@($divergence.Files) -join ', ')) }
    return ''
}

function Get-CockpitServedOf($Health) {
    if ($null -ne $Health -and [string]$Health.Detail -cmatch 'schema servi : ([a-z]+)') { return $Matches[1] }
    $served = Get-CockpitServedScheme $Root
    if ($served) { return $served }
    return 'inconnu'
}

function Write-CockpitA11($Mode, $Health) {
    $cause = Get-CockpitDivergenceText
    $lines = @(('    [!] Le cockpit en marche ne sert pas le mode inscrit dans .env (.env : {0} ; cockpit : {1}).' -f [string]$Mode.Scheme, (Get-CockpitServedOf $Health)),
        "    Aucune page n'a ete ouverte.")
    if ($cause) { $lines += ('    Cause trouvee : {0}.' -f $cause) } else { $lines += '    Cause trouvee : aucune : .env modifie sans redemarrage.' }
    $lines += '    Appliquer .env : .\cockpit.ps1 restart (les scripts ignorent ces variables et fichiers).'
    if ($cause) { $lines += '    Pour vos commandes docker compose lancees a la main : supprimez cette cause, ou utilisez -f docker-compose.yml.' }
    Write-CockpitLines $lines
}

# Echec de la verification : aucune page n'est jamais ouverte, aucun lien de connexion n'est envoye (I5).
function Write-CockpitHealthProblem($Health, $Mode, [int]$Port) {
    $scheme = [string]$Mode.Scheme
    if ($Health.Reason -ceq 'EmpreinteDifferente') {
        $expected = 'inconnue'
        if ($null -ne $Health.TlsState) { $expected = [string]$Health.TlsState.Sha256 }
        Write-CockpitLines @(('    [!] Le serveur sur 127.0.0.1:{0} ne presente PAS le certificat du cockpit.' -f $Port),
            ('    Attendue : {0}  Programme a l ecoute sur ce port : {1}' -f $expected, (Get-CockpitPortOwner $Port)),
            "    Aucune page n'a ete ouverte (aucun lien de connexion envoye).")
    } elseif ($Health.Reason -ceq 'PreuveInvalide') {
        Write-CockpitLines @(('    [!] Le serveur sur 127.0.0.1:{0} ne prouve pas qu il connait le jeton de ce cockpit.' -f $Port),
            ('    Programme a l ecoute sur ce port : {0}' -f (Get-CockpitPortOwner $Port)),
            "    Aucune page n'a ete ouverte (aucun lien de connexion envoye).",
            '    Causes possibles : le cockpit est arrete et un autre programme occupe le port (.\cockpit.ps1 status),',
            '    ou .env a ete modifie sans redemarrage (.\cockpit.ps1 restart).')
    } elseif ($Health.Reason -ceq 'JetonHorsFormat') {
        Write-CockpitLines @("    [!] Le jeton de .env n'a pas le format genere par install.ps1 (64 caracteres hexadecimaux) :",
            "    le cockpit ne peut pas prouver qu'il le connait. Aucune page n'a ete ouverte.",
            '    Solution : .\install.ps1 (nouveau jeton, reconnexion necessaire).')
    } elseif ($Health.Reason -ceq 'SchemaDifferent') {
        Write-CockpitA11 $Mode $Health
    } elseif ($Health.Reason -ceq 'ImageAncienne') {
        Write-CockpitA10 $Health.Version $Port
    } elseif ($Health.Reason -ceq 'AucuneVoie' -and $scheme -ceq 'https') {
        $fingerprint = 'inconnue'
        if ($null -ne $Health.TlsState) { $fingerprint = [string]$Health.TlsState.Sha256 }
        Write-CockpitLines @(('    [!] Aucune voie de verification utilisable ({0}).' -f $Health.Detail),
            "    Aucune page n'a ete ouverte. Verification manuelle :",
            ('      1. ouvrez {0} dans Edge ; sur l avertissement, affichez le certificat ;' -f (Get-CockpitBaseUrl 'https' $Port)),
            ('      2. comparez son empreinte SHA-256 a : {0} ;' -f $fingerprint),
            "      3. si elles sont identiques, continuez, puis saisissez dans l'ecran de connexion la valeur de COCKPIT_TOKEN",
            '         lue dans le fichier .env (ne la copiez nulle part ailleurs).')
    } elseif ($Health.Reason -ceq 'AucuneVoie') {
        Write-CockpitLines @(('    [!] Aucune voie de verification utilisable ({0}).' -f $Health.Detail),
            "    Aucune page n'a ete ouverte. En mode HTTP local, le jeton ne se saisit jamais dans une page.",
            '    Diagnostic : .\cockpit.ps1 diag. Si Edge autorise le HTTPS sur ce poste : .\install.ps1 -Https')
    } else {
        Write-CockpitLines @(('    [!] Cockpit non verifie ({0}) : {1}.' -f $Health.Reason, (Hide-Secrets $Health.Detail)),
            "    Aucune page n'a ete ouverte. Etat : .\cockpit.ps1 status ; journal : .\cockpit.ps1 logs cockpit ; diagnostic : .\cockpit.ps1 diag")
    }
}

# --- tls -Renew (plan 3.9) ------------------------------------------------------------------------------------------
function Invoke-CockpitTlsRenew($Mode, [int]$Port) {
    $project = Get-Project
    $image = Get-EnvValue 'COCKPIT_APP_IMAGE'
    if (-not $image) { throw 'Image du cockpit absente de .env (COCKPIT_APP_IMAGE) : lancez .\install.ps1' }
    $previous = $null
    if ($Mode.Scheme -ceq 'https') {
        try { $previous = Read-CockpitTlsPublic $Root } catch { $previous = $null }
        Write-Attention 'Le certificat HTTPS local va etre efface, le cockpit redemarre et un nouveau certificat cree : le navigateur affichera de nouveau "Votre connexion n est pas privee" (nouvelle empreinte a comparer).'
    } else {
        Write-Attention 'Mode HTTP local : le certificat local va etre efface. Aucun certificat n est recree maintenant ; le cockpit n est ni arrete ni redemarre.'
    }
    $answer = Read-Host 'Tapez RENOUVELER pour confirmer'
    if ($answer -cne 'RENOUVELER') { Write-Host 'Annule.'; return }
    if ($Mode.Scheme -ceq 'https') {
        Write-Step 'Arret du cockpit'
        Invoke-Docker compose stop cockpit
    }
    Write-Step 'Suppression du certificat local (volume cockpit-tls)'
    # Cle et certificats seulement : cockpit-tls.json (sans secret) reste, le serveur y lit l'empreinte precedente
    # (previousSha256, affichee par tls et par la page Diagnostic) quand il cree la nouvelle paire.
    Invoke-Docker run --rm --network none --user 1000:1000 --entrypoint rm -v ('{0}_cockpit-tls:/tls' -f $project) $image `
        -f /tls/private/cockpit.key /tls/private/cockpit.crt /tls/public/cockpit.crt
    if ($Mode.Scheme -cne 'https') {
        Write-CockpitLines @('Certificat local efface (volume cockpit-tls). Un nouveau certificat sera cree au retour en HTTPS (.\install.ps1 -Https).')
        return
    }
    Write-Step 'Redemarrage du cockpit'
    Invoke-Docker compose up -d cockpit
    Write-Step 'Attente du nouveau certificat'
    $health = Get-CockpitHealth $Mode $Port 120
    if ($health.Reason -cne 'Ok') { Write-CockpitHealthProblem $health $Mode $Port; return }
    $new = [string]$health.TlsState.Sha256
    if ($null -ne $previous) {
        Write-CockpitLines @(('    [OK] Nouveau certificat en place : ancienne empreinte {0} -> nouvelle {1}' -f $previous.Sha256, $new))
    } else {
        Write-CockpitLines @(('    [OK] Nouveau certificat en place : empreinte {0}' -f $new))
    }
    Write-CockpitLines @('    Le navigateur affichera de nouveau l avertissement de certificat : comparez cette empreinte avant de continuer.',
        '    Ouvrir : .\cockpit.ps1 open')
}

# --- rollback (plan 3.10) -------------------------------------------------------------------------------------------
# Toutes les commandes git passent par Invoke-CockpitProcess (P5) ; aucune commande reseau (ni fetch, ni pull).
function Invoke-Git([string]$GitPath, [string[]]$Arguments, [int]$TimeoutSec = 60) {
    return (Invoke-CockpitProcess -FilePath $GitPath -Arguments (@('-C', $Root) + $Arguments) -TimeoutSec $TimeoutSec)
}

function Get-CockpitGitPath {
    $found = @(Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($found.Count -eq 0) { return $null }
    return $found[0].Source
}

function Get-CockpitFirstLine([string]$Text) {
    $line = @(([string]$Text -split "`r?`n") | Where-Object { $_.Trim() })
    if ($line.Count -eq 0) { return '' }
    return (Hide-Secrets $line[0].Trim())
}

function Get-ConfigValue($Config, [string]$Key) {
    if ($null -ne $Config -and $Config.Contains($Key)) { return [string]$Config[$Key] }
    return ''
}

function Invoke-CockpitRollback {
    $config = Read-CockpitEnv
    $currentVersion = Get-CockpitVersionOrNull (Get-ConfigValue $config 'COCKPIT_VERSION')
    $installMode = Get-ConfigValue $config 'COCKPIT_INSTALL_MODE'
    if (-not $installMode) { $installMode = 'Build' }
    $mode = Get-CockpitLocalMode $config
    $access = 'HTTPS'
    if ($mode.Valid -and $mode.Scheme -ceq 'http') { $access = 'HTTP local' } elseif (-not $mode.Valid) { $access = 'a reconfigurer' }
    $full = ($null -ne $currentVersion -and $currentVersion -ge [version]'1.0.5')
    if ($full) { $target = Get-CockpitVersionOrNull (Get-ConfigValue $config 'COCKPIT_PREVIOUS_VERSION') } else { $target = $currentVersion }
    # Mode d'installation que reprendra install.ps1 apres un retour complet (meme regle que sa section 2) : en mode Load, sans
    # archive, .\cockpit.ps1 update s'arretera sur les images de la cible inscrites dans .env.
    $nextInstallMode = Get-ConfigValue $config 'COCKPIT_PREVIOUS_INSTALL_MODE'
    if (@('Build', 'Pull', 'Load') -notcontains $nextInstallMode) {
        $previousOpencode = Get-ConfigValue $config 'COCKPIT_PREVIOUS_OPENCODE_IMAGE'
        if ($previousOpencode -and $previousOpencode -notmatch ':local$') { $nextInstallMode = 'Load' } else { $nextInstallMode = 'Build' }
    }
    $loadAfter = $full -and $nextInstallMode -eq 'Load'
    if ($null -eq $target) {
        Write-Attention 'Retour impossible : aucune version precedente memorisee dans .env (COCKPIT_PREVIOUS_VERSION).'
        return
    }
    $scriptsVersion = Get-CockpitVersionOrNull $Version
    if ($null -ne $scriptsVersion -and $scriptsVersion -le $target) { Write-Host ('Deja en {0} : les scripts ne sont pas plus recents que la cible.' -f $target); return }

    # R1 : en mode Load, un retour complet exige les images de la cible (aucun telechargement).
    if ($full -and $installMode -ceq 'Load') {
        foreach ($key in @('COCKPIT_PREVIOUS_APP_IMAGE', 'COCKPIT_PREVIOUS_OPENCODE_IMAGE')) {
            $image = Get-ConfigValue $config $key
            $present = $false
            if ($image) { $present = ((Invoke-CockpitDocker '' @('image', 'inspect', '--format', '{{.Id}}', $image) 60).ExitCode -eq 0) }
            if (-not $present) {
                if (-not $image) { $image = 'inconnue' }
                Write-Attention ('Retour impossible (mode Load) : image {0} absente. Chargez l archive {1} (docker load --input <opencode-cockpit-images-{1}.tar.gz>), puis relancez.' -f $image, $target)
                return
            }
        }
    }

    $gitExe = $null
    if (Test-Path -LiteralPath (Join-Path $Root '.git')) { $gitExe = Get-CockpitGitPath }
    $branch = ''
    if ($gitExe) {
        # R3 a R8 : controles en lecture seule, dans l'ordre ; chaque echec arrete avant toute modification.
        $head = Invoke-Git $gitExe @('symbolic-ref', '-q', '--short', 'HEAD')
        if ($head.ExitCode -ne 0) { Write-Attention 'Retour impossible : HEAD git detache (aucune branche). Revenez sur votre branche, puis relancez.'; return }
        $branch = $head.StdOut.Trim()
        $dirty = Invoke-Git $gitExe @('status', '--porcelain', '--untracked-files=no')
        $changed = @(($dirty.StdOut -split "`r?`n") | Where-Object { $_.Trim() })
        if ($changed.Count -gt 0) {
            $paths = @($changed | Select-Object -First 10 | ForEach-Object { $_.Substring([Math]::Min(3, $_.Length)) })
            Write-Attention ('Retour impossible : {0} fichier(s) suivi(s) modifie(s) : {1}. Enregistrez-les ou annulez-les, puis relancez.' -f $changed.Count, ($paths -join ', '))
            return
        }
        $upstream = Invoke-Git $gitExe @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
        if ($upstream.ExitCode -ne 0) { Write-Attention ('Retour impossible : la branche {0} n a pas de suivi distant (update ne pourrait pas la ramener).' -f $branch); return }
        $ahead = Invoke-Git $gitExe @('rev-list', '--count', '@{u}..HEAD')
        $count = -1
        if ($ahead.ExitCode -eq 0 -and $ahead.StdOut.Trim() -cmatch '^[0-9]+\z') { $count = [int]$ahead.StdOut.Trim() }
        if ($count -ne 0) { Write-Attention ('Retour impossible : {0} commit(s) local(aux) non publie(s) sur {1} seraient retires de la branche.' -f [Math]::Max(0, $count), $branch); return }
        $tag = Invoke-Git $gitExe @('rev-parse', '-q', '--verify', ('refs/tags/v{0}^{{commit}}' -f $target))
        if ($tag.ExitCode -ne 0) { Write-Attention ('Retour impossible : etiquette v{0} absente. Recuperez-la : git -C "{1}" fetch --tags, puis relancez.' -f $target, $Root); return }
        $ancestor = Invoke-Git $gitExe @('merge-base', '--is-ancestor', ('v{0}' -f $target), 'HEAD')
        if ($ancestor.ExitCode -ne 0) { Write-Attention ('Retour impossible : v{0} n est pas une version anterieure de la branche {1}.' -f $target, $branch); return }
    }

    # Plan affiche avant la confirmation (A13) : ce qui sera modifie, et ce qui ne le sera pas.
    $plan = @(('==> Retour a la version {0}' -f $target), ('    Version actuelle : {0} (mode d installation {1}, acces {2})' -f $Version, $installMode, $access))
    if ($full) {
        $plan += @('    1. .env : COCKPIT_APP_IMAGE, COCKPIT_OPENCODE_IMAGE, COCKPIT_INSTALL_MODE et COCKPIT_VERSION <- valeurs de la version cible',
            '       (autres reglages conserves, dont le mode d acces et le jeton)')
    }
    if ($gitExe) {
        $plan += ('    2. Scripts : branche {0} repositionnee sur v{1} (git checkout --no-overwrite-ignore -B {0} v{1}) ;' -f $branch, $target)
        if ($loadAfter) {
            $plan += ('       git refuse s il devait ecraser un fichier ; mode Load : revenir ensuite a la {0} demandera son archive d images' -f $Version)
        } else {
            $plan += '       git refuse s il devait ecraser un fichier ; .\cockpit.ps1 update ramenera ensuite la derniere version'
        }
        if ($full) {
            $plan += ('    3. .\install.ps1 de la version {0} relance les conteneurs' -f $target)
            if ($installMode -ceq 'Build') { $plan += ('       Build : reconstruction des images {0}, acces a Docker Hub, npm et Debian requis' -f $target) }
        }
    } else {
        $plan += '    2. Scripts : dossier sans git, fichiers a remplacer a la main (consignes affichees apres la confirmation)'
    }
    if ($target -lt [version]'1.0.5') {
        $plan += @(('    [!] La version {0} est servie en HTTP, en clair, sans bandeau, et son .\cockpit.ps1 open envoie le jeton' -f $target),
            ('        sans verification ; la prochaine mise a jour vers la {0} remplacera ce jeton.' -f $Version))
    }
    $plan += '    Conserves : volume cockpit-tls, donnees, archives, sauvegardes, certs\.'
    Write-CockpitLines $plan
    $answer = Read-Host 'Tapez REVENIR pour confirmer'
    if ($answer -cne 'REVENIR') { Write-Host 'Annule.'; return }

    # Git d'abord : --no-overwrite-ignore refuse d'ecraser un fichier local ignore ici mais suivi par la cible (P14, K1-3).
    $oldHead = ''
    if ($gitExe) {
        $oldHead = (Invoke-Git $gitExe @('rev-parse', 'HEAD')).StdOut.Trim()
        Write-Step ('Scripts : branche {0} repositionnee sur v{1}' -f $branch, $target)
        $checkout = Invoke-Git $gitExe @('checkout', '--no-overwrite-ignore', '-B', $branch, ('v{0}' -f $target)) 120
        if ($checkout.ExitCode -ne 0) {
            Write-Attention ('Retour impossible : git a refuse de changer de version (un fichier local aurait ete ecrase) ; rien n a ete modifie. Detail : {0}' -f (Get-CockpitFirstLine ($checkout.StdErr + "`n" + $checkout.StdOut)))
            return
        }
    }
    if ($full) {
        try {
            Update-CockpitEnvKeys ([ordered]@{ COCKPIT_APP_IMAGE = (Get-ConfigValue $config 'COCKPIT_PREVIOUS_APP_IMAGE'); COCKPIT_OPENCODE_IMAGE = (Get-ConfigValue $config 'COCKPIT_PREVIOUS_OPENCODE_IMAGE')
                    COCKPIT_INSTALL_MODE = (Get-ConfigValue $config 'COCKPIT_PREVIOUS_INSTALL_MODE'); COCKPIT_VERSION = [string]$target })
        } catch {
            Write-Attention ('Retour interrompu : .env n a pas pu etre ecrit ({0}).' -f (Hide-Secrets $_.Exception.Message))
            if ($gitExe -and $oldHead) {
                Invoke-Git $gitExe @('checkout', '--no-overwrite-ignore', '-B', $branch, $oldHead) 120 | Out-Null
                Write-Attention 'Scripts remis dans leur etat precedent.'
            }
            return
        }
    }
    if (-not $gitExe) {
        $lines = @(('    Dossier sans git : remplacez les fichiers par ceux de la version {0}.' -f $target),
            ('      1. Telechargez l archive de l etiquette v{0} (page Releases, ou Code > Download ZIP sur v{0}) ;' -f $target),
            '      2. remplacez les fichiers, sans toucher a .env, certs\, archives\ ni backups\ ; supprimez CockpitTls.ps1 ;',
            '      3. Unblock-File .\install.ps1, .\cockpit.ps1')
        if ($full) {
            $lines += @('      4. .\install.ps1 -NoBrowser, puis .\cockpit.ps1 open',
                ('    .env pointe deja sur les images et la version {0}.' -f $target))
        } else {
            $lines += ('    Vos conteneurs {0} n ont pas change : aucune autre commande n est necessaire.' -f $target)
        }
        Write-CockpitLines $lines
        return
    }
    if (-not $full) {
        # install.ps1 est maintenant celui de la cible : ni -Http ni la version a terminer. update ramene les scripts d'abord.
        Write-CockpitLines @(('    [OK] Scripts {0} retablis.' -f $target), ('    Vos conteneurs {0} n ont pas change.' -f $target),
            ('    Terminer la mise a jour plus tard : .\cockpit.ps1 update (ramene les scripts {0} et relance l installation ;' -f $Version),
            '    s il s arrete de nouveau, suivez ses consignes)')
        return
    }
    Write-Step ('Conteneurs : install.ps1 de la version {0}' -f $target)
    & (Join-Path $Root 'install.ps1') -NoBrowser
    $end = @(('    [OK] Version {0} retablie. Ouvrir : .\cockpit.ps1 open' -f $target))
    if ($loadAfter) {
        $end += @(('    Mode Load : .\cockpit.ps1 update s arretera (images {0} inscrites dans .env). Pour revenir a la {1} dans le mode' -f $target, $Version),
            ('    d acces memorise ({0}) : .\cockpit.ps1 update, puis .\install.ps1 -Mode Load -ImagesArchive <opencode-cockpit-images-{1}.tar.gz>' -f $access, $Version))
    } else {
        $end += ('    .\cockpit.ps1 update ramenera la {0} dans le mode d acces memorise ({1}).' -f $Version, $access)
    }
    if ($target -lt [version]'1.0.5') {
        $end += @(('    [!] Rappel : la version {0} sert le cockpit en HTTP, en clair, sans bandeau ; son .\cockpit.ps1 open envoie' -f $target),
            ('        le jeton sans verification. La mise a jour vers la {0} remplacera ce jeton.' -f $Version))
    }
    if ($mode.Valid -and $mode.Scheme -ceq 'https' -and (Get-CockpitBrowserTlsPolicy -Port (Get-Port)).Verdict -ceq 'Bloque') {
        $end += @("    La mise a jour s'arretera de nouveau tant qu'Edge interdit l'avertissement ;",
            '    choisissez alors .\install.ps1 -Http, ou attendez l exception.')
    }
    Write-CockpitLines $end
}

# Un chemin de sauvegarde relatif se lit depuis le dossier courant de l'utilisateur, pas depuis $Root.
if ($Command -eq 'restore' -and $Target) {
    $Target = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Target)
}

Push-Location $Root
try {
    switch ($Command) {
        'open' {
            $mode = Get-AccessMode
            if (-not $mode.Valid) { Write-CockpitA18 $mode; return }
            $port = Get-Port
            $running = Get-RunningImageVersion
            if (Test-CockpitUnfinishedUpdate $running) { Write-CockpitA10 $running $port; return }
            $policy = Get-CockpitBrowserTlsPolicy -Port $port
            if ($mode.Scheme -ceq 'http') { Write-CockpitModeNotice $mode $policy -OneLine }
            $health = Get-CockpitHealth $mode $port 20
            if ($health.Reason -cne 'Ok') { Write-CockpitHealthProblem $health $mode $port; return }
            if ($mode.Scheme -ceq 'https') {
                Write-CockpitLines @(('    [OK] Cockpit disponible sur {0} (certificat epingle et preuve du jeton verifies : {1})' -f (Get-CockpitBaseUrl 'https' $port), (Get-CockpitMethodLabel $health.Method)),
                    ('    Empreinte SHA-256 du certificat : {0} (valable jusqu au {1})' -f $health.TlsState.Sha256, $health.TlsState.NotAfter.ToString('yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture)))
            } else {
                Write-CockpitLines @(('    [OK] Cockpit disponible sur {0} (mode HTTP local, preuve du jeton verifiee : {1})' -f (Get-CockpitBaseUrl 'http' $port), (Get-CockpitMethodLabel $health.Method)))
            }
            $login = Get-CockpitLoginUrl -Health $health -Port $port -Mode $mode -Token (Get-EnvValue 'COCKPIT_TOKEN')
            if (-not $login.Url) {
                Write-CockpitLines @(('    [!] Lien de connexion non obtenu ({0}) : {1}.' -f $login.Reason, (Hide-Secrets $login.Detail)),
                    "    Aucune page n'a ete ouverte. Diagnostic : .\cockpit.ps1 diag")
                return
            }
            $decision = Get-CockpitOpenDecision $health $mode $policy
            Write-CockpitLines $decision.Lines
            if ($decision.Decision -cne 'Open') { return }
            Write-CockpitLines @('    Le lien ouvert est a usage unique (10 minutes) et ne contient pas votre jeton.')
            Start-Process $login.Url
        }
        'start' {
            Assert-CockpitOutsideWorkspace
            $mode = Get-AccessMode
            if (-not $mode.Valid) { Write-CockpitA18 $mode; return }
            $port = Get-Port
            if ($mode.Scheme -ceq 'http') { Write-CockpitModeNotice $mode (Get-CockpitBrowserTlsPolicy -Port $port) -OneLine }
            $running = Get-RunningImageVersion
            if (Test-CockpitUnfinishedUpdate $running) { Write-CockpitA10Short $running }
            Write-Step 'Demarrage'
            Invoke-Docker compose up -d
        }
        'stop' {
            Write-Step 'Arret'
            Invoke-Docker compose stop
        }
        'restart' {
            Assert-CockpitOutsideWorkspace
            $mode = Get-AccessMode
            if (-not $mode.Valid) { Write-CockpitA18 $mode; return }
            $port = Get-Port
            if ($mode.Scheme -ceq 'http') { Write-CockpitModeNotice $mode (Get-CockpitBrowserTlsPolicy -Port $port) -OneLine }
            $running = Get-RunningImageVersion
            if (Test-CockpitUnfinishedUpdate $running) { Write-CockpitA10Short $running }
            # 'compose restart' garderait l'ancienne configuration : on recree les conteneurs pour relire .env.
            Write-Step 'Redemarrage (configuration .env relue)'
            Invoke-Docker compose up -d --force-recreate
        }
        'status' {
            Invoke-Docker compose ps
            $mode = Get-AccessMode
            if (-not $mode.Valid) { Write-CockpitA18 $mode; return }
            $port = Get-Port
            if ($mode.Scheme -ceq 'http') { Write-CockpitModeNotice $mode (Get-CockpitBrowserTlsPolicy -Port $port) -OneLine }
            $running = Get-RunningImageVersion
            if (Test-CockpitUnfinishedUpdate $running) { Write-CockpitA10 $running $port; return }
            $health = Get-CockpitHealth $mode $port 5
            if ($health.Reason -cne 'Ok') {
                Write-Attention ('Cockpit : non verifie ({0} : {1}) - detail : .\cockpit.ps1 diag' -f $health.Reason, (Hide-Secrets $health.Detail))
                return
            }
            if ($mode.Scheme -ceq 'https') {
                $days = [int][Math]::Floor(($health.TlsState.NotAfter - (Get-Date).ToUniversalTime()).TotalDays)
                Write-Host ('Cockpit : disponible sur {0} (empreinte {1}, expire dans {2} jours, voie {3})' -f (Get-CockpitBaseUrl 'https' $port), $health.TlsState.Sha256, $days, (Get-CockpitMethodLabel $health.Method)) -ForegroundColor Green
            } else {
                Write-Host ('Cockpit : disponible sur {0} (preuve du jeton verifiee, voie {1})' -f (Get-CockpitBaseUrl 'http' $port), (Get-CockpitMethodLabel $health.Method)) -ForegroundColor Green
            }
        }
        'logs' {
            if ($Target -and @('opencode', 'cockpit') -notcontains $Target) { throw 'Service inconnu : utilisez "logs opencode" ou "logs cockpit".' }
            if ($Target) { Invoke-Docker compose logs --tail 200 -f $Target }
            else { Invoke-Docker compose logs --tail 200 -f }
        }
        'diag' {
            Write-Step 'Diagnostic (lecture seule)'
            $project = Get-Project
            $oc = "$project-opencode-1"
            Write-Host ''
            Write-Host '--- Conteneurs ---'
            $containers = Invoke-DockerTimeout 20 ps -a --filter "name=$project-" --format '{{.Names}} | {{.Status}} | {{.Image}}'
            if ($containers.TimedOut) {
                Write-Attention 'docker ps ne repond pas en 20 s : Docker Desktop est bloque. Redemarrez-le (wsl --shutdown, puis relancez Docker Desktop).'
                return
            }
            Write-Host $containers.Output
            if ($containers.Output -match ([regex]::Escape($oc) + ' \| Created')) {
                Write-Attention 'opencode est reste a l etat Created : Docker n arrive pas a le lancer. Placez WORKSPACE_DIR sur un disque local (ni lecteur reseau, ni OneDrive), puis redemarrez Docker Desktop.'
            }
            Write-Host ''
            Write-Host '--- Acces a l interface ---'
            if (-not (Test-Path -LiteralPath $EnvFile)) {
                Write-Attention 'Fichier .env introuvable : lancez diag depuis le dossier du cockpit installe.'
            } else {
                $mode = Get-AccessMode
                $port = Get-Port
                $policy = Get-CockpitBrowserTlsPolicy -Port $port
                # 1. Mode inscrit dans .env.
                if (-not $mode.Valid) { Write-CockpitA18 $mode }
                elseif ($mode.Scheme -ceq 'http') { Write-Host ('Mode (.env)     : http, confirme le {0} UTC' -f $mode.ConfirmedAt) }
                else { Write-Host 'Mode (.env)     : https' }
                # Mise a jour inachevee (image du cockpit anterieure a 1.0.5) : elle sert toujours en HTTP et ignore
                # COCKPIT_LOCAL_SCHEME, dont la valeur dans le conteneur ne dit donc rien du mode servi.
                $running = Get-RunningImageVersion
                $unfinished = Test-CockpitUnfinishedUpdate $running
                # 2. Mode reellement servi par le conteneur (valeur demandee seule, jamais l'environnement du conteneur).
                if ($unfinished) { Write-Host ('Mode (cockpit)  : http (cockpit {0} anterieur a 1.0.5, mode d acces non gere)' -f $running) }
                else {
                    $served = Get-CockpitServedScheme $Root
                    if (-not $served) { Write-Host 'Mode (cockpit)  : illisible (conteneur arrete ?)' }
                    elseif ($mode.Valid -and $served -ceq [string]$mode.Scheme) { Write-Host ('Mode (cockpit)  : {0}' -f $served) }
                    else {
                        Write-Attention ('Mode (cockpit)  : {0} - different de .env' -f $served)
                        $cause = Get-CockpitDivergenceText
                        if ($cause) {
                            Write-Host ('                  Cause : {0}' -f $cause)
                            Write-Host '                  Remede : .\cockpit.ps1 restart, puis supprimez cette cause pour vos commandes docker lancees a la main (ou -f docker-compose.yml).'
                        } else {
                            Write-Host '                  Cause : aucune trouvee (.env modifie sans redemarrage). Remede : .\cockpit.ps1 restart'
                        }
                    }
                }
                # 3. Conteneur cockpit : sante Docker, mise a jour inachevee, derniere erreur de configuration HTTPS.
                $containerHealth = Get-CockpitContainerHealth $Root
                if ($containerHealth) { Write-Host ('Conteneur       : sante Docker {0}' -f $containerHealth) } else { Write-Host 'Conteneur       : absent ou sante illisible' }
                if ($unfinished) { Write-CockpitA10 $running $port }
                if ($containerHealth -cne 'healthy') {
                    $journal = Invoke-DockerTimeout 20 compose logs --tail 200 cockpit
                    $failures = @(($journal.Output -split "`r?`n") | Where-Object { $_ -match 'HTTPS local impossible' } | Select-Object -Last 1)
                    if ($failures.Count -gt 0) { Write-Attention ('Journal cockpit : {0}' -f (Hide-Secrets $failures[0])) }
                }
                # 4. Sante verifiee par les scripts (certificat epingle en HTTPS, preuve du jeton dans les deux modes).
                # diag ne compile rien (plan 3.11) : en HTTPS, curl.exe seul ; la classe .NET reste reservee a open, status et tls.
                $noCompile = $false
                if ($mode.Valid -and -not $unfinished) {
                    $diagMethods = @()
                    if ($mode.Scheme -ceq 'https') { $diagMethods = @('curl') }
                    $health = Get-CockpitHealth $mode $port 5 $diagMethods
                    $noCompile = ($mode.Scheme -ceq 'https' -and $health.Reason -ceq 'AucuneVoie')
                    if ($noCompile) {
                        Write-Attention ('Sante           : non verifiee par diag ({0}). diag ne lance aucune compilation ; verification par la classe .NET : .\cockpit.ps1 status' -f (Hide-Secrets $health.Detail))
                    } else {
                        Write-Host ('Sante           : {0} (voie {1}, version {2}) {3}' -f $health.Reason, (Get-CockpitMethodLabel $health.Method), $health.Version, (Hide-Secrets $health.Detail))
                    }
                    if (@('EmpreinteDifferente', 'PreuveInvalide') -contains $health.Reason) {
                        Write-Attention ('Programme a l ecoute sur le port {0} : {1}' -f $port, (Get-CockpitPortOwner $port))
                    }
                    # 5. Certificat servi et refus TLS vus par le serveur.
                    if ($mode.Scheme -ceq 'https') {
                        if ($null -ne $health.TlsState) {
                            Write-Host ('Certificat      : {0}' -f $health.TlsState.Sha256)
                            Write-Host ('                  valable du {0} au {1} (UTC), SAN {2}' -f $health.TlsState.NotBefore.ToString('yyyy-MM-dd'), $health.TlsState.NotAfter.ToString('yyyy-MM-dd'), (@($health.TlsState.San) -join ', '))
                            foreach ($warning in @(Get-CockpitCertWarnings $health.TlsState)) { Write-Attention $warning.Text }
                        } else { Write-Host 'Certificat      : non publie (cockpit arrete ou demarrage en cours)' }
                        # Resumes du serveur (TlsRefusals, au plus un par minute) : {"msg":"connexions TLS refusees ...","total":N,...}.
                        # Motif ASCII, independant de l'encodage de la console ; seuls les totaux sont additionnes.
                        $tlsJournal = Invoke-DockerTimeout 20 compose logs --since 30m cockpit
                        $summaries = @(($tlsJournal.Output -split "`r?`n") | Where-Object { $_.Contains('"msg":"connexions TLS refus') })
                        $refusedTotal = [long]0
                        foreach ($summary in $summaries) { if ($summary -cmatch '"total":([0-9]{1,9})[,}]') { $refusedTotal += [long]$Matches[1] } }
                        Write-Host ('Refus TLS       : {0} connexion(s) refusee(s) sur 30 min ({1} resume(s) du journal ; une requete toutes les 10 s environ est du bruit de fond normal)' -f $refusedTotal, $summaries.Count)
                    } else {
                        Write-Host 'Certificat      : non utilise (mode HTTP local)'
                    }
                }
                # 6. Poste gere : strategies lues dans le registre (edge://policy fait foi), voie de verification.
                $source = 'aucune'
                if ($policy.Source) { $source = [string]$policy.Source }
                Write-Host ('Edge            : SSLErrorOverrideAllowed = {0} ({1}), verdict {2} pour {3}' -f (Format-CockpitEdgePolicyValue $policy), $source, $policy.Verdict, $policy.Origin)
                if (@($policy.Origins).Count -gt 0) { Write-Host ('                  exceptions declarees : {0}' -f (@($policy.Origins) -join ', ')) }
                if ($null -ne $policy.Chrome.Value) { Write-Host ('Chrome          : SSLErrorOverrideAllowed = {0} ({1}) - information' -f $policy.Chrome.Value, $policy.Chrome.Source) }
                foreach ($item in @($policy.HttpsOnly)) { Write-Host ('                  {0} = {1} ({2}) - information' -f $item.Name, $item.Value, $item.Source) }
                $curl = Get-CockpitCurl
                if ($curl.Available) { Write-Host ('curl.exe        : {0} (Schannel)' -f $curl.Version) } else { Write-Host ('curl.exe        : inutilisable ({0})' -f $curl.Reason) }
                $route = 'HttpWebRequest (mode HTTP)'
                if ($mode.Valid -and $mode.Scheme -ceq 'https') { if ($curl.Available) { $route = ('curl ({0}, Schannel)' -f $curl.Version) } else { $route = 'classe .NET (compilation, alerte antivirus possible)' } }
                Write-Host ('Voie qui serait utilisee : {0}' -f $route)
                Write-Host ('PowerShell      : LanguageMode {0} ; Windows {1}' -f $ExecutionContext.SessionState.LanguageMode, [Environment]::OSVersion.Version)
                $browser = 'inconnu'
                try {
                    $association = Get-ItemProperty -LiteralPath 'HKCU:\SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction SilentlyContinue
                    if ($null -ne $association -and $association.PSObject.Properties['ProgId']) { $browser = [string]$association.ProgId }
                } catch { $browser = 'inconnu' }
                Write-Host ('Navigateur https: {0}' -f $browser)
                # 7. Verdict en une ligne : "Edge interdit" seulement si la strategie lue vaut Bloque (J2-10).
                if ($policy.Verdict -ceq 'Bloque') {
                    Write-Attention ('Verdict : Edge interdit de passer l avertissement de certificat pour {0} (aucune exception lue). Demandez SSLErrorOverrideAllowedForOrigins, ou choisissez .\install.ps1 -Http ; edge://policy fait foi.' -f $policy.Origin)
                } elseif ($mode.Valid -and $mode.Scheme -ceq 'http' -and @('Autorise', 'Couvert') -contains [string]$policy.Verdict) {
                    Write-CockpitLines @(("    Edge semble autoriser le passage de l'avertissement (ou l'exception {0} est en place) :" -f $policy.Origin),
                        '    le mode HTTPS est probablement utilisable. Verifiez edge://policy, puis : .\install.ps1 -Https')
                } elseif (-not $mode.Valid) {
                    Write-Attention 'Verdict : mode d acces invalide dans .env (voir ci-dessus).'
                } elseif ($unfinished) {
                    Write-Attention 'Verdict : mise a jour inachevee (voir ci-dessus).'
                } elseif ($noCompile) {
                    Write-Attention 'Verdict : interface non verifiee par diag (curl.exe inutilisable, aucune compilation ici) : .\cockpit.ps1 status'
                } elseif ($health.Reason -ceq 'Ok') {
                    Write-Host ('Verdict : interface joignable et verifiee sur {0}' -f (Get-CockpitBaseUrl ([string]$mode.Scheme) $port)) -ForegroundColor Green
                } else {
                    Write-Attention ('Verdict : interface non verifiee ({0}).' -f $health.Reason)
                }
            }
            Write-Host ''
            # 1.0.6 : opencode n'a qu'une sortie, le relais du cockpit. Un hote hors de sa liste fermee est refuse sur place (403 au
            # CONNECT) : rien n'est envoye au proxy de l'entreprise, ce test ne peut donc declencher aucune alerte pour ces hotes.
            Write-Host '--- Acces reseau depuis le conteneur opencode (seule sortie : le relais du cockpit ; certificats du cockpit, sans jeton) ---'
            $hostsToProbe = @('api.githubcopilot.com', 'api.business.githubcopilot.com', 'api.enterprise.githubcopilot.com', 'api.github.com', 'github.com', 'models.opencode.ai', 'registry.npmjs.org')
            foreach ($probeHost in $hostsToProbe) {
                # En-tetes sur /dev/stdout plutot que "-D -" : un argument "-" isole est refuse par powershell.exe -File (banc de test).
                $probe = Invoke-DockerTimeout 25 exec $oc curl -s -m 15 --cacert /home/node/.cockpit/ca-bundle.pem -o /dev/null -D /dev/stdout -w 'code=%{http_code} relais=%{http_connect}' "https://$probeHost/"
                $code = '---'
                $relayCode = ''
                if ($probe.Output -match 'code=(\d{3})') { $code = $Matches[1] }
                if ($probe.Output -match 'relais=(\d{3})') { $relayCode = $Matches[1] }
                if ($probe.TimedOut) { $verdict = 'pas de reponse (conteneur bloque ?)' }
                elseif ($code -eq '---') { $verdict = 'test impossible (conteneur arrete ?)' }
                elseif ($code -eq '000' -and $relayCode -eq '403') { $verdict = 'bloque sur place par le relais du cockpit (rien envoye au proxy de l entreprise)' }
                elseif ($code -eq '000' -and $relayCode -eq '502') { $verdict = 'permis par le relais, mais refuse ou injoignable en amont (proxy de l entreprise)' }
                elseif ($code -eq '000') { $verdict = 'INJOIGNABLE (relais du cockpit, proxy, pare-feu ou certificat)' }
                elseif ($probe.Output -match '(?im)^x-github-request-id:') { $verdict = 'joignable' }
                elseif ($probeHost -like '*github*') { $verdict = 'reponse sans marque GitHub : page de blocage du proxy ?' }
                else { $verdict = 'joignable' }
                Write-Host ('{0,-34} {1}  {2}' -f $probeHost, $code, $verdict)
            }
            # Refus du relais journalises par le cockpit (une ligne par hote et par heure) : hotes seulement, jamais d'adresse complete.
            $relayJournal = Invoke-DockerTimeout 20 compose logs --no-color --since 24h cockpit
            $relayRefusals = @(($relayJournal.Output -split "`r?`n") | Where-Object { $_.Contains('"msg":"sortie d' + "'" + 'opencode refus') })
            $relayHosts = @($relayRefusals | ForEach-Object { if ($_ -cmatch '"hote":"([!-~]{1,253}?)"') { $Matches[1] } } | Sort-Object -Unique)
            if ($relayRefusals.Count -eq 0) { Write-Host 'Relais (24 h)   : aucun refus journalise' }
            else { Write-Host ('Relais (24 h)   : {0} ligne(s) de refus, hotes bloques sur place : {1}' -f $relayRefusals.Count, (($relayHosts | Select-Object -First 15) -join ', ')) }
            Write-Host ''
            Write-Host '--- Journal d opencode : lignes d erreur recentes (secrets courants masques ; journal complet : page Diagnostic) ---'
            $journal = Invoke-DockerTimeout 20 logs --tail 300 $oc
            if ($journal.TimedOut) { Write-Attention 'Journal illisible en 20 s.' }
            elseif (-not $journal.Output) { Write-Attention 'Journal vide : opencode n a jamais demarre (voir l etat du conteneur ci-dessus).' }
            else {
                $problems = @($journal.Output -split "`r?`n" | Where-Object { $_ -match 'level=(ERROR|WARN)|ERREUR|Error|EACCES|denied' } | Select-Object -Last 20)
                if ($problems.Count -eq 0) { Write-Host 'Aucune ligne d erreur dans les 300 dernieres lignes.' }
                foreach ($line in $problems) { Write-Host (Hide-Secrets $line) }
            }
            Write-Host ''
            Write-Host 'Pare-feu qui n ouvre que l adresse de votre abonnement (api.business ou api.enterprise joignable, api.githubcopilot.com bloquee) :'
            Write-Host '  .\install.ps1 -CopilotApiUrl https://api.business.githubcopilot.com -NoBrowser'
        }
        'tls' {
            $mode = Get-AccessMode
            if (-not $mode.Valid) { Write-CockpitA18 $mode; return }
            $port = Get-Port
            $running = Get-RunningImageVersion
            if (Test-CockpitUnfinishedUpdate $running) { Write-CockpitA10 $running $port; return }
            if ($Renew) { Invoke-CockpitTlsRenew $mode $port; return }
            $policy = Get-CockpitBrowserTlsPolicy -Port $port
            if ($mode.Scheme -cne 'https') {
                Write-CockpitModeNotice $mode $policy -OneLine
                Write-CockpitLines @("Mode HTTP local : aucun certificat n'est servi. Le volume cockpit-tls n'est ni lu ni modifie par le cockpit ;",
                    'un certificat precedent y reste et sera reutilise au retour en HTTPS s il est encore valable.',
                    ('Strategie Edge lue : SSLErrorOverrideAllowed = {0}, verdict {1} pour {2} (edge://policy fait foi).' -f (Format-CockpitEdgePolicyValue $policy), $policy.Verdict, $policy.Origin),
                    'Effacer le certificat local malgre tout : .\cockpit.ps1 tls -Renew')
                return
            }
            $state = Read-CockpitTlsPublic $Root
            if ($null -eq $state) {
                Write-Attention 'Certificat local non publie : le cockpit est arrete ou son demarrage a echoue (.\cockpit.ps1 status, .\cockpit.ps1 logs cockpit).'
                return
            }
            Write-Host ('Empreinte SHA-256 : {0}' -f $state.Sha256)
            Write-Host ('Cle publique      : sha256//{0}' -f $state.SpkiBase64)
            Write-Host ('Valable           : du {0} au {1} (UTC)' -f $state.NotBefore.ToString('yyyy-MM-dd'), $state.NotAfter.ToString('yyyy-MM-dd'))
            Write-Host ('Noms couverts     : {0}' -f (@($state.San) -join ', '))
            if ($state.PreviousSha256) { Write-Host ('Empreinte avant   : {0}' -f (Format-CockpitFingerprint $state.PreviousSha256)) }
            foreach ($warning in @(Get-CockpitCertWarnings $state)) { Write-Attention $warning.Text }
            $health = Get-CockpitHealth $mode $port 5
            if ($health.Reason -ceq 'Ok') { Write-Host ('Cockpit verifie sur {0} (certificat epingle et preuve du jeton, voie {1})' -f (Get-CockpitBaseUrl 'https' $port), (Get-CockpitMethodLabel $health.Method)) -ForegroundColor Green }
            else { Write-CockpitHealthProblem $health $mode $port }
            Write-Host ('Strategie Edge lue : SSLErrorOverrideAllowed = {0}, verdict {1} pour {2} (edge://policy fait foi).' -f (Format-CockpitEdgePolicyValue $policy), $policy.Verdict, $policy.Origin)
            Write-Host 'Nouveau certificat (cockpit arrete puis redemarre) : .\cockpit.ps1 tls -Renew'
        }
        'certs' {
            Assert-CockpitOutsideWorkspace
            Write-Step 'Reexport des certificats de confiance Windows vers certs\windows-trust.pem'
            $builder = New-Object System.Text.StringBuilder
            $seen = @{}
            foreach ($store in @('Cert:\LocalMachine\Root', 'Cert:\CurrentUser\Root', 'Cert:\LocalMachine\CA')) {
                foreach ($cert in (Get-ChildItem -Path $store -ErrorAction SilentlyContinue)) {
                    if ($cert.NotAfter -lt (Get-Date) -or $seen.ContainsKey($cert.Thumbprint)) { continue }
                    $seen[$cert.Thumbprint] = $true
                    $base64 = [Convert]::ToBase64String($cert.RawData, [System.Base64FormattingOptions]::InsertLineBreaks)
                    [void]$builder.Append("-----BEGIN CERTIFICATE-----`n")
                    [void]$builder.Append($base64.Replace("`r`n", "`n"))
                    [void]$builder.Append("`n-----END CERTIFICATE-----`n")
                }
            }
            $certsDir = Join-Path $Root 'certs'
            New-Item -ItemType Directory -Path $certsDir -Force | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $certsDir 'windows-trust.pem'), $builder.ToString(), (New-Object System.Text.UTF8Encoding $false))
            Write-Host ("{0} certificats exportes." -f $seen.Count)
            Write-Step 'Recreation des conteneurs pour prise en compte'
            Invoke-Docker compose up -d --force-recreate
        }
        'update' {
            Assert-CockpitOutsideWorkspace
            $gitExe = $null
            if (Test-Path -LiteralPath (Join-Path $Root '.git')) { $gitExe = Get-CockpitGitPath }
            if (-not $gitExe) {
                Write-Attention 'Pas de depot git : remplacez les fichiers par ceux de la nouvelle version (sans toucher a .env, certs\, archives\ ni backups\), lancez Unblock-File .\install.ps1, .\cockpit.ps1, .\CockpitTls.ps1, puis .\install.ps1'
                return
            }
            Write-Step 'Recuperation de la derniere version (git pull)'
            $pull = Invoke-Git $gitExe @('pull', '--ff-only') 600
            $pullOutput = ($pull.StdOut + $pull.StdErr).Trim()
            if ($pullOutput) { Write-Host (Hide-Secrets $pullOutput) }
            if ($pull.TimedOut) { throw 'git pull ne repond pas : relancez quand le reseau sera disponible.' }
            if ($pull.ExitCode -ne 0) { throw 'git pull a echoue : resolvez le conflit puis relancez.' }
            # Le mode d'acces memorise dans .env est repris tel quel : ni -Http ni -Https ici (I2).
            & (Join-Path $Root 'install.ps1') -NoBrowser
        }
        'rollback' {
            Invoke-CockpitRollback
        }
        'backup' {
            $project = Get-Project
            $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            $backupDir = Join-Path $Root 'backups'
            New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
            $image = Get-EnvValue 'COCKPIT_APP_IMAGE'
            $archiveDir = Get-ArchiveDir
            Write-Step 'Arret temporaire pour une sauvegarde coherente'
            Invoke-Docker compose stop
            try {
                Write-Step "Sauvegarde vers backups\cockpit-$stamp.tar.gz"
                # Conversations de la salle comprises (decision du 17/09 n. 3) ; les deux auth.json restent exclus.
                Invoke-Docker run --rm --entrypoint tar `
                    -v "${project}_cockpit-data:/src/cockpit-data:ro" `
                    -v "${project}_oc-config:/src/oc-config:ro" `
                    -v "${project}_oc-data:/src/oc-data:ro" `
                    -v "${project}_${OmoDataVolume}:/src/${OmoDataVolume}:ro" `
                    -v "${archiveDir}:/src/archives:ro" `
                    -v "${backupDir}:/backup" `
                    $image czf "/backup/cockpit-$stamp.tar.gz" --exclude=oc-data/auth.json "--exclude=$OmoDataVolume/auth.json" --exclude=oc-config/node_modules -C /src .
            } finally {
                Invoke-Docker compose start
            }
            Write-Host 'Sauvegarde terminee. Exclus volontairement : jeton GitHub Copilot (auth.json, celui de la salle compris), fichier .env, dossier certs\ et certificat HTTPS local (volume cockpit-tls).' -ForegroundColor Green
        }
        'restore' {
            if (-not $Target -or -not (Test-Path -LiteralPath $Target -PathType Leaf)) {
                throw 'Indiquez une sauvegarde existante : .\cockpit.ps1 restore .\backups\cockpit-AAAAMMJJ-HHMMSS.tar.gz'
            }
            $project = Get-Project
            $backup = Get-Item -LiteralPath $Target
            if ($backup.Name -notmatch '^[A-Za-z0-9._-]+\.tar\.gz$') { throw 'Nom de sauvegarde inattendu : lettres, chiffres, point, tiret, souligne et extension .tar.gz uniquement.' }
            $image = Get-EnvValue 'COCKPIT_APP_IMAGE'
            $archiveDir = Get-ArchiveDir
            # Verification AVANT tout arret : une archive illisible ne coupe pas le cockpit.
            Write-Step "Verification de $($backup.Name)"
            Invoke-Docker run --rm --entrypoint tar -v "$($backup.DirectoryName):/backup:ro" $image tzf "/backup/$($backup.Name)" | Out-Null
            Write-Attention 'La restauration REMPLACE les reglages, couts, archives indexees et la configuration opencode actuels.'
            Write-Attention 'Le dossier archives\ est complete : les fichiers absents de la sauvegarde restent, ceux de meme nom sont remplaces. La connexion GitHub Copilot est conservee.'
            $answer = Read-Host 'Tapez RESTAURER pour confirmer'
            if ($answer -cne 'RESTAURER') { Write-Host 'Annule.'; return }
            Invoke-Docker compose up --no-start
            Invoke-Docker compose stop
            try {
                Write-Step "Restauration de $($backup.Name)"
                # Les deux auth.json (instance principale et salle) survivent a la restauration : ils ne sont pas dans l archive.
                $script = "set -e; " +
                    "for d in cockpit-data oc-config oc-data $OmoDataVolume; do find /dst/`$d -mindepth 1 -maxdepth 1 ! -name auth.json -exec rm -rf {} +; done; " +
                    "tar xzf /backup/$($backup.Name) --no-same-owner -C /dst; chown -R 1000:1000 /dst/cockpit-data /dst/oc-config /dst/oc-data /dst/$OmoDataVolume"
                Invoke-Docker run --rm --user 0 --entrypoint sh `
                    -v "${project}_cockpit-data:/dst/cockpit-data" `
                    -v "${project}_oc-config:/dst/oc-config" `
                    -v "${project}_oc-data:/dst/oc-data" `
                    -v "${project}_${OmoDataVolume}:/dst/${OmoDataVolume}" `
                    -v "${archiveDir}:/dst/archives" `
                    -v "$($backup.DirectoryName):/backup:ro" `
                    $image -c $script
            } finally {
                # Redemarrage dans tous les cas, meme si la restauration a echoue.
                Write-Step 'Redemarrage des conteneurs'
                Invoke-Docker compose up -d --force-recreate
            }
            Write-Host 'Restauration terminee.' -ForegroundColor Green
        }
        'uninstall' {
            if ($PurgeOmo -and -not $Purge) { throw '-PurgeOmo ne s utilise qu avec -Purge : .\cockpit.ps1 uninstall -Purge -PurgeOmo' }
            if ($Purge) {
                Write-Attention 'Suppression DEFINITIVE des conteneurs, des volumes du cockpit (reglages, couts, connexion Copilot, certificat HTTPS local) et des images du cockpit designees dans .env.'
                if ($PurgeOmo) {
                    Write-Attention 'ET DE LA SALLE : son image, ses volumes (conversations comprises) et sa configuration figee. Cette image ne se retelecharge pas : il faut la reconstruire sur le PC personnel, puis la recopier avec son fichier .sha256.'
                } else {
                    Write-Attention 'Conserves : l image de la salle, ses volumes (conversations) et sa configuration (-PurgeOmo, avec -Purge, pour les supprimer aussi).'
                }
                Write-Attention 'Conserves : archives\, backups\, certs\ et .env. Images d anciennes versions : docker image ls, puis docker image rm.'
                Write-Attention 'A la reinstallation : nouveau certificat local, donc nouvel avertissement a accepter dans le navigateur.'
                $answer = Read-Host 'Tapez SUPPRIMER pour confirmer'
                if ($answer -cne 'SUPPRIMER') { Write-Host 'Annule.'; return }
                $project = Get-Project
                # Conteneurs et reseau d'abord, la salle comprise (le profil est ajoute quand .env porte COCKPIT_OMO=on) :
                # un conteneur du profil encore en vie empecherait de supprimer le reseau et ses volumes (MO-3 point 2).
                Invoke-Docker compose down --remove-orphans
                # Volumes nommes un par un, jamais --volumes : ceux de la salle ne partent qu'avec -PurgeOmo.
                $volumes = @($CockpitVolumes)
                if ($PurgeOmo) { $volumes += $OmoVolumes }
                $volumeArgs = @($volumes | ForEach-Object { '{0}_{1}' -f $project, $_ })
                $removed = Invoke-DockerTimeout 180 volume rm -f @volumeArgs
                if ($removed.ExitCode -ne 0) { Write-Attention ('Volumes non supprimes : ' + (Get-CockpitFirstLine $removed.Output)) }
                # Images nommees une par une, jamais --rmi all : celle de la salle ne part qu'avec -PurgeOmo.
                $images = @((Get-EnvValue 'COCKPIT_APP_IMAGE'), (Get-EnvValue 'COCKPIT_OPENCODE_IMAGE'))
                if ($PurgeOmo) { $images += (Get-EnvValue 'COCKPIT_OMO_IMAGE') }
                $images = @($images | Where-Object { $_ })
                if ($images.Count -gt 0) {
                    $dropped = Invoke-DockerTimeout 180 image rm -f @images
                    if ($dropped.ExitCode -ne 0) { Write-Attention ('Images non supprimees : ' + (Get-CockpitFirstLine $dropped.Output)) }
                }
                Write-Host 'Desinstallation terminee.' -ForegroundColor Green
            } else {
                Invoke-Docker compose down
                Write-Host 'Conteneurs supprimes. Les donnees restent dans les volumes Docker (-Purge pour tout effacer).'
            }
        }
        default {
            Get-Help $MyInvocation.MyCommand.Path -Detailed | Out-Host
        }
    }
} finally {
    Pop-Location
}
