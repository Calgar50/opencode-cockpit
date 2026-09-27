# build-omo-image.ps1 - construction locale de l'image opencode-omo (Oh My OpenAgent 4.19.4), sur le PC personnel seulement.
# Spec. 3.15.1 point 2 (l.453-461), 7.1 (l.1087), 7.5 (l.1143), G14 (l.1228) ; plan 2 bis, fiche L15b ; D-2b-32.
# Windows PowerShell 5.1, ASCII + BOM + CRLF. Lance a la main, avec Internet ; jamais par la CI (P13).
# Aucun envoi vers un registre, aucune connexion a un registre : l'archive va du PC personnel au poste de travail, qui la
# charge par install.ps1 -OmoArchive. Commandes externes par tableaux d'arguments ; aucun code construit a partir de texte.
#
# Usage : powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\build-omo-image.ps1 -BaseImage <nom>@sha256:<64 hex>
#           [-OutDir <dossier>] [-AcceptManifest | -UpdateLock | -SelfTest] [-DryRun]
#   (defaut)        construction sans cache, journal de npm ci, npm audit compare a audit-baseline.json, SBOM, validation et
#                   manifeste sans reseau, puis archive docker save compressee et son fichier .sha256.
#   -AcceptManifest amorcage de docker\opencode-omo\omo-manifest.sha256 (D-2b-32) : construction 1, extraction du manifeste,
#                   ecriture de la reference, construction 2, manifeste identique exige (sinon reference precedente
#                   restauree et arret), puis la suite normale sur la construction 2.
#   -UpdateLock     regenere docker\opencode-omo\package-lock.json dans une copie temporaire, avec le npm de l'image de base
#                   (install --package-lock-only --ignore-scripts), le controle, puis le recopie en verifiant son empreinte.
#   -SelfTest       G14, dans des copies temporaires : le temoin doit se construire et passer la validation ; un nom de hook
#                   faux, une cle inconnue et une valeur epinglee retiree doivent chacun faire echouer la construction, a
#                   l etape de validation du Dockerfile et avec un message qui les cite (toute autre panne : non concluant).
#   -DryRun         affiche chaque commande docker (dont les deux constructions de l'amorcage) sans lancer Docker et sans
#                   rien ecrire dans le depot ni dans le dossier de sortie.
# -BaseImage : image opencode du cockpit, epinglee par empreinte (<nom>[:etiquette]@sha256:<64 hex>) ; refusee sinon.
#              Son ENV doit porter les drapeaux de la 1.0.6 (OPENCODE_DISABLE_MODELS_FETCH=1, npm_config_offline=true) :
#              une base plus ancienne est refusee (decision D7 b de la grande fusion), relue par docker image inspect.
# -OutDir : archive, .sha256, audit, SBOM et journaux (defaut : %USERPROFILE%\opencode-cockpit-omo). Jamais dans le depot, qui
#   est public : rien de tout cela n'y est publie.
# Fichier <archive>.sha256 (LF), lu par install.ps1 -OmoArchive :
#   <sha256 de l'archive, 64 hex>  opencode-cockpit-omo-4.19.4-<aaaammjj-hhmmss>.tar.gz
#   image-id sha256:<64 hex>
#   image opencode-cockpit/opencode-omo:4.19.4-<aaaammjj-hhmmss>
# Chemins de l'image : lus dans docker\opencode-omo\contrat-salle.json (cheminsImage, perimetreManifeste), jamais recopies ici.
# Code de sortie : 0 si tout est vert ; 1 sinon, apres un message ARRET.
[CmdletBinding()]
param(
    [string]$BaseImage = '',
    [string]$OutDir = '',
    [switch]$UpdateLock,
    [switch]$SelfTest,
    [switch]$AcceptManifest,
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$OmoDir = Join-Path $RepoRoot 'docker\opencode-omo'
$OmoPackage = 'oh-my-openagent'
$OmoVersion = '4.19.4'
$ImageRepository = 'opencode-cockpit/opencode-omo'
$ArchiveBase = 'opencode-cockpit-omo-' + $OmoVersion
$TempPrefix = 'opencode-omo-build-'
# Conteneurs jetables du script : aucune capacite, aucun gain de privilege (comme la salle, contrat : securite).
$Hardening = @('--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true')
$script:DockerPath = $null
$script:TagsToRemove = New-Object System.Collections.Generic.List[string]
$script:TempDirs = New-Object System.Collections.Generic.List[string]

# --- Fonctions pures (app/server/build-omo-image.test.ts les charge depuis l'arbre syntaxique, sans executer le script) --------

# Propriete d'un objet lu par ConvertFrom-Json, $null si absente (StrictMode Latest refuse une propriete absente).
# Valeur rendue telle quelle, tableau compris : l'affecter a une variable, jamais l'envelopper dans @() (tableau dans un tableau).
function Get-OmoProp($Object, [string]$Name) {
    if ($Object -isnot [System.Management.Automation.PSCustomObject]) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return , $property.Value
}

function Test-OmoSameSet([string[]]$Left, [string[]]$Right) {
    return ((@($Left | Sort-Object -CaseSensitive) -join '|') -ceq (@($Right | Sort-Object -CaseSensitive) -join '|'))
}

# Texte venu d'un outil ou d'un fichier, reduit avant affichage : ASCII imprimable, longueur bornee.
function Get-OmoSafeText([string]$Text, [int]$Max = 120) {
    $clean = [regex]::Replace([string]$Text, '[^ -~]', '?')
    if ($clean.Length -gt $Max) { $clean = $clean.Substring(0, $Max) + '...' }
    return $clean
}

# Masque les formes de secrets les plus courantes avant affichage ou journal (memes regles que Hide-Secrets de CockpitTls.ps1).
function Hide-OmoSecrets([string]$Text) {
    $masked = $Text -replace '(?i)([a-z][a-z0-9+.-]*://[^:\s/@]+:)[^@\s]+@', '$1****@'
    $masked = $masked -replace '(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}', '$1****'
    $masked = $masked -replace '(?i)(authorization\s*[:=]\s*(bearer|basic|token)\s+)\S+', '$1****'
    $masked = $masked -replace '(?i)((pass(word|wd)?|pwd|secret|token|api[_-]?key|_auth)\s*[:=]\s*)\S+', '$1****'
    return $masked
}

# Regles de CommandLineToArgvW (celles de docker.exe) ; sert aussi a l'affichage des commandes.
function ConvertTo-OmoArgText([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"&|<>^%()]') { return $Value }
    $builder = New-Object System.Text.StringBuilder '"'
    $slashes = 0
    foreach ($ch in $Value.ToCharArray()) {
        if ($ch -eq [char]92) { $slashes++; continue }
        if ($ch -eq [char]34) { [void]$builder.Append([char]92, 2 * $slashes + 1) } elseif ($slashes -gt 0) { [void]$builder.Append([char]92, $slashes) }
        [void]$builder.Append($ch)
        $slashes = 0
    }
    return $builder.Append([char]92, 2 * $slashes).Append('"').ToString()
}

function Format-OmoArgs([string[]]$Arguments) { return (@($Arguments | ForEach-Object { ConvertTo-OmoArgText $_ }) -join ' ') }

# Vrai si $Path est $Root ou se trouve dessous (casse ignoree, comme le systeme de fichiers de Windows).
function Test-OmoInside([string]$Path, [string]$Root) {
    $p = $Path.TrimEnd([char]92, [char]47) + '\'
    $r = $Root.TrimEnd([char]92, [char]47) + '\'
    return $p.StartsWith($r, [System.StringComparison]::OrdinalIgnoreCase)
}

# Image de base epinglee par empreinte : une etiquette seule peut changer de contenu entre deux constructions.
function Test-OmoBaseImage([string]$Value) {
    if ($Value.Length -gt 400) { return $false }
    $component = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*'
    $pattern = '^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?/)?' + $component + '(?:/' + $component + ')*' +
        '(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[0-9a-f]{64}\z'
    return ($Value -cmatch $pattern)
}

# Drapeaux de la 1.0.6 exiges dans l'ENV de l'image de base (decision D7 b de la grande fusion) : sans eux, la salle
# heriterait d'une image qui telecharge le catalogue des modeles et laisse npm sortir a l'execution. Entree : sortie de
# docker image inspect --format '{{json .Config.Env}}' (tableau JSON de chaines CLE=VALEUR ; noms sensibles a la casse).
function Get-OmoBaseFlagProblems([string]$EnvJson) {
    $problems = New-Object System.Collections.Generic.List[string]
    $entries = $null
    try { $entries = ConvertFrom-Json $EnvJson } catch { $problems.Add('ENV de l image de base illisible'); return $problems.ToArray() }
    $values = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::Ordinal)
    foreach ($entry in @($entries)) {
        if ($entry -isnot [string]) { continue }
        $at = $entry.IndexOf('=')
        if ($at -gt 0) { $values[$entry.Substring(0, $at)] = $entry.Substring($at + 1) }
    }
    foreach ($flag in @(@('OPENCODE_DISABLE_MODELS_FETCH', '1'), @('npm_config_offline', 'true'))) {
        $name = $flag[0]
        $wanted = $flag[1]
        if (-not $values.ContainsKey($name)) { $problems.Add(('{0}={1} absent de l ENV de l image de base' -f $name, $wanted)) }
        elseif ($values[$name] -cne $wanted) { $problems.Add(('{0} vaut {1} dans l image de base, {2} attendu' -f $name, (Get-OmoSafeText $values[$name] 40), $wanted)) }
    }
    return $problems.ToArray()
}

# Chemins de l'image et perimetre du manifeste, lus dans le contrat machine (D-2b-39) : absolus, sans .. ni //.
function Read-OmoContract([string]$Text) {
    $contract = $null
    try { $contract = ConvertFrom-Json $Text } catch { $contract = $null }
    if ($contract -isnot [System.Management.Automation.PSCustomObject]) { throw 'contrat-salle.json illisible (objet JSON attendu).' }
    $images = Get-OmoProp $contract 'cheminsImage'
    $paths = @{}
    foreach ($key in @('valider', 'manifeste', 'extension', 'referenceManifeste')) { $paths[$key] = [string](Get-OmoProp $images $key) }
    $perimeterValue = Get-OmoProp $contract 'perimetreManifeste'
    $perimeter = @($perimeterValue)
    foreach ($path in @(@($paths.Values) + $perimeter)) {
        if ([string]$path -cnotmatch '^/[A-Za-z0-9._/-]+\z' -or [string]$path -match '(^|/)\.\.?(/|\z)' -or ([string]$path).Contains('//')) {
            throw ('contrat-salle.json : chemin de l image invalide ou absent : ' + (Get-OmoSafeText $path 80))
        }
    }
    if ($perimeter.Count -eq 0) { throw 'contrat-salle.json : perimetreManifeste vide.' }
    return [pscustomobject]@{ Valider = $paths['valider']; Manifeste = $paths['manifeste']; Extension = $paths['extension']
        Reference = $paths['referenceManifeste']; Perimetre = [string[]]$perimeter }
}

# Lignes utiles d'un manifeste, comme supervisor-lib.mjs : sans blanc de fin, sans ligne vide, sans commentaire.
function Get-OmoManifestLines([string]$Text) {
    return @(([string]$Text).Replace("`r", '') -split "`n" | ForEach-Object { $_.TrimEnd() } | Where-Object { $_ -ne '' -and -not $_.StartsWith('#') })
}

# Amorce commitee par L15a (une ligne '# amorce', aucune ligne utile) : jamais une reference valable.
function Test-OmoAmorce([string]$Text) {
    return (([string]$Text -cmatch '(?m)^[ \t]*#[ \t]*amorce\b') -and @(Get-OmoManifestLines $Text).Count -eq 0)
}

# 'ok' | 'amorce' | 'ecart', meme verdict que comparerManifeste (supervisor-lib.mjs) : ferme en cas de doute.
function Compare-OmoManifest([string]$Current, [string]$Reference) {
    $actual = @(Get-OmoManifestLines $Current)
    if ($actual.Count -eq 0) { return 'ecart' }
    if (Test-OmoAmorce $Reference) { return 'amorce' }
    $expected = @(Get-OmoManifestLines $Reference)
    if ($expected.Count -eq 0 -or $expected.Count -ne $actual.Count) { return 'ecart' }
    for ($i = 0; $i -lt $expected.Count; $i++) { if ($expected[$i] -cne $actual[$i]) { return 'ecart' } }
    return 'ok'
}

# Un manifeste n'est ecrit ou compare que s'il est fait des lignes de manifest.sh couvrant tout le perimetre du contrat, et rien
# d'autre : '<sha256>  <chemin>' (fichier) et 'meta <type> <droits> <uid>:<gid> <chemin>[ -> <cible>]' (chaque entree). Hors
# lien, une entree appartient a root (0:0), sans ecriture pour le groupe ni les autres, sans setuid ni setgid : ni un message
# d'erreur de manifest.sh ni une image que node pourrait modifier ne deviennent une reference (spec. 3.15.1 : root, sans ecriture).
function Get-OmoManifestProblems([string]$Text, [string[]]$Perimeter) {
    $problems = New-Object System.Collections.Generic.List[string]
    $lines = @(Get-OmoManifestLines $Text)
    if ($lines.Count -eq 0) { $problems.Add('manifeste vide'); return $problems.ToArray() }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    $hashed = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    $described = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($line in $lines) {
        $meta = [regex]::Match($line, '^meta (?<t>[a-z]) (?<m>[0-7]{3,4}) (?<o>[0-9]+:[0-9]+) (?<p>/.*?)(?<l> -> .*)?\z')
        $hash = [regex]::Match($line, '^\\?[0-9a-f]{64} [ *](?<p>/.*)\z')
        if ($meta.Success) {
            $path = $meta.Groups['p'].Value
            if (-not $described.Add($path)) { $problems.Add('chemin en double : ' + (Get-OmoSafeText $path)) }
            $mode = $meta.Groups['m'].Value
            if ($meta.Groups['t'].Value -cne 'l' -and ($meta.Groups['o'].Value -cne '0:0' -or $mode.Substring($mode.Length - 2) -match '[2367]' -or
                ($mode.Length -eq 4 -and $mode.Substring(0, 1) -match '[2-7]'))) {
                $problems.Add('entree hors de root, inscriptible par le groupe ou les autres, ou setuid : ' + (Get-OmoSafeText $line))
            }
        } elseif ($hash.Success) {
            $path = $hash.Groups['p'].Value
            if (-not $hashed.Add($path)) { $problems.Add('chemin en double : ' + (Get-OmoSafeText $path)) }
        } else { $problems.Add('ligne hors format : ' + (Get-OmoSafeText $line 80)); continue }
        $root = $null
        foreach ($candidate in $Perimeter) {
            if ($path -ceq $candidate -or $path.StartsWith($candidate + '/', [System.StringComparison]::Ordinal)) { $root = $candidate; break }
        }
        if ($null -eq $root) { $problems.Add('chemin hors du perimetre : ' + (Get-OmoSafeText $path)) } else { [void]$seen.Add($root) }
    }
    foreach ($root in $Perimeter) { if (-not $seen.Contains($root)) { $problems.Add('aucune entree pour ' + $root) } }
    return $problems.ToArray()
}

# Journal de docker build --progress=plain : npm ci --ignore-scripts present, rejoue (pas en cache), aucun script de cycle de vie.
function Get-OmoBuildLogProblems([string[]]$Lines) {
    $problems = New-Object System.Collections.Generic.List[string]
    $ciSteps = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    $events = '(preinstall|install|postinstall|preprepare|prepare|postprepare)'
    foreach ($line in @($Lines)) {
        $text = [string]$line
        if ($text -match '^#(\d+) \[[^\]]*\] RUN (.*)\z') {
            $step = $Matches[1]
            $command = $Matches[2]
            # Chaque appel de npm de l'etape, jusqu'a son separateur de commande : --ignore-scripts vaut pour cet appel seulement.
            foreach ($npm in [regex]::Matches($command, '\bnpm\s+(ci|install|i|add|rebuild|update|exec|x)\b', 'IgnoreCase')) {
                $verb = $npm.Groups[1].Value
                $call = @($command.Substring($npm.Index) -split '&&|\|\||;|\|')[0]
                if ($verb -ne 'ci') { $problems.Add(('npm {0} au lieu de npm ci (etape #{1})' -f $verb, $step)) }
                elseif ($call -notmatch '(^|\s)--ignore-scripts(=true)?(\s|\z)') { $problems.Add(('npm ci sans --ignore-scripts (etape #{0})' -f $step)) }
                else { [void]$ciSteps.Add($step) }
            }
            continue
        }
        if ($text -match '^#(\d+) CACHED\s*\z' -and $ciSteps.Contains($Matches[1])) { $problems.Add(('etape npm ci #{0} en cache : son journal manque' -f $Matches[1])); continue }
        if ($text -match ('(^|\s)> \S+@\S+ ' + $events + '\b') -or $text -match ('\bnpm (info|verb|verbose|sill|silly) run \S+ ' + $events + '\b') -or
            $text -match '\bgyp info (it worked|spawn)\b') {
            $problems.Add('script de cycle de vie au journal : ' + (Get-OmoSafeText $text))
        }
    }
    if ($ciSteps.Count -eq 0) { $problems.Add('aucune etape npm ci --ignore-scripts au journal') }
    return $problems.ToArray()
}

# package.json de docker/opencode-omo : l'extension epinglee exactement, aucune plage de versions, aucune autre section.
function Get-OmoPackageJsonProblems([string]$Text, [string]$Package, [string]$Version) {
    $problems = New-Object System.Collections.Generic.List[string]
    $manifest = $null
    try { $manifest = ConvertFrom-Json $Text } catch { $manifest = $null }
    if ($manifest -isnot [System.Management.Automation.PSCustomObject]) { $problems.Add('package.json illisible (objet JSON attendu)'); return $problems.ToArray() }
    $dependencies = Get-OmoProp $manifest 'dependencies'
    if ($dependencies -isnot [System.Management.Automation.PSCustomObject]) { $problems.Add('package.json sans dependencies'); return $problems.ToArray() }
    if ((Get-OmoProp $dependencies $Package) -cne $Version) { $problems.Add(('{0} doit etre epingle exactement en {1}' -f $Package, $Version)) }
    foreach ($dependency in $dependencies.PSObject.Properties) {
        if ([string]$dependency.Value -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+\z') { $problems.Add('version non epinglee : ' + (Get-OmoSafeText $dependency.Name 80)) }
    }
    foreach ($section in @('devDependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies', 'overrides', 'scripts', 'workspaces')) {
        if ($null -ne $manifest.PSObject.Properties[$section]) { $problems.Add('section refusee dans package.json : ' + $section) }
    }
    return $problems.ToArray()
}

# Lockfile : l'extension a la version epinglee, chaque paquet venu du registre npm en HTTPS avec son integrite SHA-512
# (npm ci ne verifie que les empreintes presentes au lockfile), aucun lien local.
function Get-OmoLockfileProblems([string]$Text, [string]$Package, [string]$Version) {
    $problems = New-Object System.Collections.Generic.List[string]
    # PS 5.1 : ConvertFrom-Json refuse la cle vide de l'entree racine ("packages": {"": ...}) ; elle est renommee avant lecture.
    $readable = [regex]::Replace([string]$Text, '(?<=[{,]\s*)""(?=\s*:)', '"(racine)"')
    $lock = $null
    try { $lock = ConvertFrom-Json $readable } catch { $lock = $null }
    if ($lock -isnot [System.Management.Automation.PSCustomObject]) { $problems.Add('package-lock.json illisible (objet JSON attendu)'); return $problems.ToArray() }
    if (@('2', '3') -notcontains [string](Get-OmoProp $lock 'lockfileVersion')) { $problems.Add('lockfileVersion 2 ou 3 attendu') }
    $packages = Get-OmoProp $lock 'packages'
    if ($packages -isnot [System.Management.Automation.PSCustomObject]) { $problems.Add('section packages absente du lockfile'); return $problems.ToArray() }
    $main = Get-OmoProp $packages ('node_modules/' + $Package)
    if ((Get-OmoProp $main 'version') -cne $Version) { $problems.Add(('{0} {1} absent du lockfile' -f $Package, $Version)) }
    $count = 0
    foreach ($property in $packages.PSObject.Properties) {
        if ($property.Name -ceq '(racine)') { continue }
        $count++
        $name = Get-OmoSafeText $property.Name
        $entry = $property.Value
        if ($entry -isnot [System.Management.Automation.PSCustomObject]) { $problems.Add('entree invalide : ' + $name); continue }
        if ((Get-OmoProp $entry 'link') -eq $true) { $problems.Add('lien local refuse : ' + $name); continue }
        if ((Get-OmoProp $entry 'inBundle') -eq $true) { continue }
        if (-not ([string](Get-OmoProp $entry 'resolved')).StartsWith('https://registry.npmjs.org/', [System.StringComparison]::Ordinal)) { $problems.Add('source hors du registre npm : ' + $name) }
        if ([string](Get-OmoProp $entry 'integrity') -cnotmatch '^sha512-[A-Za-z0-9+/]{86}==\z') { $problems.Add('integrite sha512 absente : ' + $name) }
    }
    if ($count -eq 0) { $problems.Add('aucun paquet au lockfile') }
    return $problems.ToArray()
}

# audit-baseline.json : cles fermees ; chaque alerte acceptee nomme son paquet, son avis, sa gravite, sa raison et sa date.
function Read-OmoBaseline([string]$Text, [string]$Package, [string]$Version) {
    $baseline = $null
    try { $baseline = ConvertFrom-Json $Text } catch { $baseline = $null }
    if ($baseline -isnot [System.Management.Automation.PSCustomObject]) { throw 'audit-baseline.json illisible (objet JSON attendu).' }
    if (-not (Test-OmoSameSet @($baseline.PSObject.Properties | ForEach-Object { $_.Name }) @('version', 'description', 'paquet', 'versionPaquet', 'alertesAcceptees'))) {
        throw 'audit-baseline.json : cles attendues exactement version, description, paquet, versionPaquet, alertesAcceptees.'
    }
    if ([string](Get-OmoProp $baseline 'version') -cne '1') { throw 'audit-baseline.json : version 1 attendue.' }
    if ((Get-OmoProp $baseline 'paquet') -cne $Package -or (Get-OmoProp $baseline 'versionPaquet') -cne $Version) { throw ('audit-baseline.json ne porte pas sur {0} {1}.' -f $Package, $Version) }
    $entries = Get-OmoProp $baseline 'alertesAcceptees'
    if ($entries -isnot [System.Array]) { throw 'audit-baseline.json : alertesAcceptees doit etre un tableau.' }
    foreach ($entry in $entries) {
        if ($entry -isnot [System.Management.Automation.PSCustomObject] -or
            -not (Test-OmoSameSet @($entry.PSObject.Properties | ForEach-Object { $_.Name }) @('paquet', 'avis', 'severite', 'raison', 'accepteeLe'))) {
            throw 'audit-baseline.json : chaque alerte acceptee porte exactement paquet, avis, severite, raison, accepteeLe.'
        }
        if ([string](Get-OmoProp $entry 'paquet') -cnotmatch '^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*\z' -or
            [string](Get-OmoProp $entry 'avis') -cnotmatch '^(GHSA(-[0-9a-z]{4}){3}|[0-9]{1,12})\z' -or
            @('high', 'critical') -cnotcontains [string](Get-OmoProp $entry 'severite') -or
            ([string](Get-OmoProp $entry 'raison')).Trim().Length -eq 0 -or ([string](Get-OmoProp $entry 'raison')).Length -gt 300 -or
            [string](Get-OmoProp $entry 'accepteeLe') -cnotmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}\z') {
            throw 'audit-baseline.json : alerte acceptee mal formee (paquet npm, avis GHSA ou numero, high ou critical, raison, date aaaa-mm-jj).'
        }
    }
    return , $entries
}

function Get-OmoAdvisoryId($Via) {
    $match = [regex]::Match([string](Get-OmoProp $Via 'url'), '(GHSA(?:-[0-9a-z]{4}){3})\z')
    if ($match.Success) { return $match.Groups[1].Value }
    $source = [string](Get-OmoProp $Via 'source')
    if ($source -cmatch '^[0-9]{1,12}\z') { return $source }
    return ''
}

# Rapport de npm audit --json (auditReportVersion 2) compare aux alertes acceptees : une alerte haute ou critique absente de la
# base est nouvelle. Rapport illisible, en erreur ou incoherent : Probleme non vide (ferme en cas de doute).
function Get-OmoAuditVerdict([string]$AuditJson, [object[]]$Accepted) {
    $verdict = [pscustomobject]@{ Probleme = ''; Nouvelles = @(); Acceptees = @(); Mineures = 0 }
    $audit = $null
    try { $audit = ConvertFrom-Json $AuditJson } catch { $audit = $null }
    if ($audit -isnot [System.Management.Automation.PSCustomObject]) { $verdict.Probleme = 'rapport illisible (JSON attendu)'; return $verdict }
    $failure = Get-OmoProp $audit 'error'
    if ($null -ne $failure) { $verdict.Probleme = 'npm audit a echoue : ' + (Get-OmoSafeText ([string](Get-OmoProp $failure 'code')) 40); return $verdict }
    $vulnerabilities = Get-OmoProp $audit 'vulnerabilities'
    $counts = Get-OmoProp (Get-OmoProp $audit 'metadata') 'vulnerabilities'
    if ([string](Get-OmoProp $audit 'auditReportVersion') -cne '2' -or $vulnerabilities -isnot [System.Management.Automation.PSCustomObject] -or
        $counts -isnot [System.Management.Automation.PSCustomObject]) {
        $verdict.Probleme = 'format de rapport inattendu (auditReportVersion 2, vulnerabilities et metadata attendus)'
        return $verdict
    }
    $known = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    foreach ($entry in @($Accepted)) { [void]$known.Add([string](Get-OmoProp $entry 'paquet') + '|' + [string](Get-OmoProp $entry 'avis')) }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::Ordinal)
    $new = New-Object System.Collections.Generic.List[string]
    $tolerated = New-Object System.Collections.Generic.List[string]
    $minor = 0
    foreach ($property in $vulnerabilities.PSObject.Properties) {
        $vias = Get-OmoProp $property.Value 'via'
        foreach ($via in @($vias)) {
            # Une chaine renvoie a l'avis d'un autre paquet, compte sous ce paquet-la.
            if ($via -isnot [System.Management.Automation.PSCustomObject]) { continue }
            $name = [string](Get-OmoProp $via 'name')
            if (-not $name) { $name = $property.Name }
            $id = Get-OmoAdvisoryId $via
            $key = $name + '|' + $id
            if (-not $seen.Add($key)) { continue }
            $severity = [string](Get-OmoProp $via 'severity')
            if (@('high', 'critical') -notcontains $severity) { $minor++; continue }
            $label = '{0} {1} ({2})' -f (Get-OmoSafeText $name 80), (Get-OmoSafeText $id 40), (Get-OmoSafeText $severity 10)
            if ($id -and $known.Contains($key)) { $tolerated.Add($label) } else { $new.Add($label) }
        }
    }
    $announced = 0
    foreach ($level in @('high', 'critical')) { $value = Get-OmoProp $counts $level; if ($null -ne $value) { $announced += [int]$value } }
    if ($announced -gt 0 -and ($new.Count + $tolerated.Count) -eq 0) { $verdict.Probleme = 'compteurs incoherents : alertes hautes annoncees, aucune lue' }
    $verdict.Nouvelles = $new.ToArray()
    $verdict.Acceptees = $tolerated.ToArray()
    $verdict.Mineures = $minor
    return $verdict
}

# G14 : mutations de omo.jsonc pour -SelfTest. Ancre introuvable : arret (un auto-test sans mutation ne prouverait rien).
# Ancres croisees avec le omo.jsonc de L15a par build-omo-image.test.ts.
function Set-OmoSelfTestMutation([string]$Text, [string]$Case) {
    $hookAnchor = '"disabled_hooks"\s*:\s*\['
    $keyAnchor = '"disabled_hooks"\s*:'
    $pinnedAnchor = '"hashline_edit"\s*:\s*false\s*,'
    $pinnedAnchorLast = ',\s*"hashline_edit"\s*:\s*false'
    switch -CaseSensitive ($Case) {
        'hook-faux' { $result = ([regex]$hookAnchor).Replace($Text, '$0"g14-crochet-inexistant", ', 1) }
        'cle-inconnue' { $result = ([regex]$keyAnchor).Replace($Text, '"g14_cle_inconnue": true, $0', 1) }
        'valeur-retiree' {
            $result = ([regex]$pinnedAnchor).Replace($Text, '', 1)
            if ($result -ceq $Text) { $result = ([regex]$pinnedAnchorLast).Replace($Text, '', 1) }
        }
        default { throw ('Cas d auto-test inconnu : ' + (Get-OmoSafeText $Case 40)) }
    }
    if ($result -ceq $Text) { throw ('omo.jsonc : ancre de la mutation {0} introuvable ; l auto-test ne prouverait rien.' -f $Case) }
    return $result
}

# Nom que le message de refus de validate-core.mjs (L15a) doit citer pour chaque mutation.
function Get-OmoSelfTestMarker([string]$Case) {
    switch -CaseSensitive ($Case) {
        'hook-faux' { return 'g14-crochet-inexistant' }
        'cle-inconnue' { return 'g14_cle_inconnue' }
        'valeur-retiree' { return 'hashline_edit' }
        default { throw ('Cas d auto-test inconnu : ' + (Get-OmoSafeText $Case 40)) }
    }
}

# G14 : une construction ne compte comme refus que si elle echoue A L ETAPE 'RUN node <validate.mjs> --construction' du
# Dockerfile, avec un message qui cite la mutation. Une panne de reseau, de npm ou de l image de base ne prouve rien.
function Test-OmoSelfTestRefusal([string[]]$Lines, [string]$Valider, [string]$Marker) {
    $step = $null
    $failed = $false
    $named = $false
    foreach ($line in @($Lines)) {
        $text = [string]$line
        $run = [regex]::Match($text, '^#(\d+) \[[^\]]*\] RUN node (\S+) --construction\s*\z')
        if ($run.Success -and $run.Groups[2].Value -ceq $Valider) { $step = $run.Groups[1].Value; continue }
        if ($null -eq $step -or -not $text.StartsWith('#' + $step + ' ', [System.StringComparison]::Ordinal)) { continue }
        if ($text.StartsWith('#' + $step + ' ERROR:', [System.StringComparison]::Ordinal)) { $failed = $true }
        elseif ($text.Contains($Marker)) { $named = $true }
    }
    return ($failed -and $named)
}

function Format-OmoChecksumFile([string]$ArchiveName, [string]$ArchiveSha256, [string]$ImageId, [string]$ImageTag) {
    if ($ArchiveName -cnotmatch '^opencode-cockpit-omo-[0-9]+\.[0-9]+\.[0-9]+-[0-9]{8}-[0-9]{6}\.tar\.gz\z' -or $ArchiveSha256 -cnotmatch '^[0-9a-f]{64}\z' -or
        $ImageId -cnotmatch '^sha256:[0-9a-f]{64}\z' -or $ImageTag -cnotmatch '^opencode-cockpit/opencode-omo:[0-9A-Za-z_][0-9A-Za-z_.-]{0,127}\z') {
        throw 'Fichier .sha256 : valeur hors format, rien n est ecrit.'
    }
    return ('{0}  {1}' -f $ArchiveSha256, $ArchiveName) + "`n" + ('image-id ' + $ImageId) + "`n" + ('image ' + $ImageTag) + "`n"
}

# Compression gzip par .NET : le tube PowerShell 5.1 abime un flux binaire, docker save ecrit donc d'abord un .tar.
function Compress-OmoGzip([string]$Source, [string]$Destination) {
    $in = [System.IO.File]::OpenRead($Source)
    try {
        $out = New-Object System.IO.FileStream -ArgumentList $Destination, ([System.IO.FileMode]::CreateNew), ([System.IO.FileAccess]::Write), ([System.IO.FileShare]::None)
        try {
            $gzip = New-Object System.IO.Compression.GZipStream -ArgumentList $out, ([System.IO.Compression.CompressionLevel]::Optimal)
            try { $in.CopyTo($gzip) } finally { $gzip.Dispose() }
        } finally { $out.Dispose() }
    } finally { $in.Dispose() }
}

# Vrai seulement si l'archive se decompresse a l'identique de la source (empreintes Get-FileHash des deux cotes).
function Test-OmoGzipRoundTrip([string]$Source, [string]$Archive) {
    $expected = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash
    $file = [System.IO.File]::OpenRead($Archive)
    try {
        $gzip = New-Object System.IO.Compression.GZipStream -ArgumentList $file, ([System.IO.Compression.CompressionMode]::Decompress)
        try { $actual = (Get-FileHash -InputStream $gzip -Algorithm SHA256).Hash }
        catch [System.IO.InvalidDataException] { Write-Host ('   archive compressee illisible : ' + $_.Exception.Message); return $false }
        finally { $gzip.Dispose() }
    } finally { $file.Dispose() }
    return ($actual -ceq $expected)
}

# --- Fichiers : empreinte verifiee avant tout usage ----------------------------------------------------------------------------

function Read-OmoText([string]$Path) { return [System.IO.File]::ReadAllText($Path, (New-Object System.Text.UTF8Encoding $false)) }

function Get-OmoSha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Write-OmoFileVerified([string]$Path, [string]$Text) { Write-OmoBytesVerified $Path ((New-Object System.Text.UTF8Encoding $false).GetBytes($Text)) }

function Write-OmoBytesVerified([string]$Path, [byte[]]$Bytes) {
    [System.IO.File]::WriteAllBytes($Path, $Bytes)
    $stream = New-Object System.IO.MemoryStream -ArgumentList (, $Bytes)
    try { $expected = (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash.ToLowerInvariant() } finally { $stream.Dispose() }
    if ((Get-OmoSha256 $Path) -cne $expected) { throw ('Ecriture non verifiee par empreinte : ' + $Path) }
}

function Copy-OmoFileVerified([string]$Source, [string]$Destination) {
    [System.IO.File]::Copy($Source, $Destination, $true)
    if ((Get-OmoSha256 $Source) -cne (Get-OmoSha256 $Destination)) { throw ('Copie non verifiee par empreinte : ' + $Destination) }
}

# Contexte de construction recopie fichier par fichier ; un lien (jonction, lien symbolique) est refuse.
function Copy-OmoContext([string]$Source, [string]$Destination) {
    [void][System.IO.Directory]::CreateDirectory($Destination)
    foreach ($item in @(Get-ChildItem -LiteralPath $Source -Force)) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('Lien refuse dans le contexte de construction : ' + $item.FullName) }
        $target = Join-Path $Destination $item.Name
        if ($item.PSIsContainer) { Copy-OmoContext $item.FullName $target } else { Copy-OmoFileVerified $item.FullName $target }
    }
}

# Suppression d'un dossier temporaire du script : un lien est retire seul, jamais sa cible.
function Remove-OmoTree([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        if ($item.PSIsContainer) { [System.IO.Directory]::Delete($item.FullName, $false) } else { [System.IO.File]::Delete($item.FullName) }
        return
    }
    if ($item.PSIsContainer) {
        foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) { Remove-OmoTree $child.FullName }
        [System.IO.Directory]::Delete($item.FullName, $false)
    } else {
        if ($item.IsReadOnly) { $item.IsReadOnly = $false }
        [System.IO.File]::Delete($item.FullName)
    }
}

# Dossiers temporaires du script retires en fin de course : seulement sous le dossier temporaire de Windows et a son prefixe.
function Remove-OmoWorkDirs([string[]]$Dirs) {
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    foreach ($dir in @($Dirs)) {
        $full = [System.IO.Path]::GetFullPath($dir)
        if (-not (Test-OmoInside $full $tempRoot) -or -not (Split-Path -Leaf $full).StartsWith($TempPrefix, [System.StringComparison]::Ordinal)) { Write-Host ('   dossier inattendu garde : ' + $full); continue }
        try { if (Test-Path -LiteralPath $full) { Remove-OmoTree $full } } catch { Write-Host ('   dossier temporaire garde : {0} ({1})' -f $full, $_.Exception.Message) }
    }
}

# Dossier temporaire du script ; en simulation, seulement nomme, sauf -Create (copies de l'auto-test, sans Docker).
function New-OmoWorkDir([string]$Purpose, [switch]$Create) {
    $path = Join-Path ([System.IO.Path]::GetTempPath()) ($TempPrefix + $Purpose + '-' + [guid]::NewGuid().ToString('N'))
    if ($DryRun -and -not $Create) { return $path }
    [void][System.IO.Directory]::CreateDirectory($path)
    $script:TempDirs.Add($path)
    return $path
}

function Save-OmoLog([string]$Target, [string]$FileName, [string[]]$Lines) {
    if ($DryRun) { return }
    [System.IO.File]::WriteAllLines((Join-Path $Target $FileName), [string[]]@($Lines), (New-Object System.Text.UTF8Encoding $false))
}

# --- Affichage et docker -------------------------------------------------------------------------------------------------------

function Write-OmoStep([string]$Text) { Write-Host ''; Write-Host ('== ' + $Text) -ForegroundColor Cyan }
function Write-OmoLine([string]$Text) { Write-Host ('   ' + $Text) }
function Write-OmoProblems([string[]]$Problems) {
    foreach ($problem in @($Problems | Select-Object -First 20)) { Write-Host ('   - ' + $problem) -ForegroundColor Red }
    if (@($Problems).Count -gt 20) { Write-Host ('   - ... et {0} autre(s)' -f (@($Problems).Count - 20)) -ForegroundColor Red }
}

# Seul appel de docker. En simulation : la commande est affichee, rien n'est lance.
function Invoke-OmoDocker {
    param([string[]]$Arguments, [switch]$Stream)
    if ($DryRun) {
        Write-Host ('[simulation] docker ' + (Format-OmoArgs $Arguments)) -ForegroundColor Yellow
        return [pscustomobject]@{ ExitCode = 0; StdOut = ''; Lines = [string[]]@() }
    }
    Write-Host ('   > docker ' + (Hide-OmoSecrets (Format-OmoArgs $Arguments))) -ForegroundColor DarkGray
    return Invoke-CockpitProcess -FilePath $script:DockerPath -Arguments $Arguments -Stream:$Stream
}

# Seul lancement de processus du script (nom admis par tests/ps51/Validate-Scripts.ps1) : sorties lues en asynchrone (une ligne
# stderr ne leve rien), encodage UTF-8, aucune entree, lignes de stderr masquees. -Stream les affiche au fil de l'eau.
function Invoke-CockpitProcess {
    param([string]$FilePath, [string[]]$Arguments, [switch]$Stream)
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.Arguments = Format-OmoArgs $Arguments
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = $utf8
    $info.StandardErrorEncoding = $utf8
    $lines = New-Object System.Collections.Generic.List[string]
    $process = [System.Diagnostics.Process]::Start($info)
    try {
        $process.StandardInput.Close()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        if ($Stream) {
            while ($null -ne ($line = $process.StandardError.ReadLine())) {
                $masked = Hide-OmoSecrets $line
                $lines.Add($masked)
                Write-Host ('   | ' + $masked)
            }
            $process.WaitForExit()
        } else {
            $stderr = $process.StandardError.ReadToEndAsync()
            $process.WaitForExit()
            foreach ($item in ($stderr.Result -split "`r?`n")) { if ($item -ne '') { $lines.Add((Hide-OmoSecrets $item)) } }
        }
        return [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = $stdout.Result; Lines = $lines.ToArray() }
    } finally { $process.Dispose() }
}

function Get-OmoRunArguments([string]$Image, [string]$Entrypoint, [string[]]$Command) {
    return @(@('run', '--rm', '--network', 'none') + $Hardening + @('--entrypoint', $Entrypoint, $Image) + @($Command))
}

function Get-OmoImageId([string]$Reference) {
    $result = Invoke-OmoDocker -Arguments @('image', 'inspect', '--format', '{{.Id}}', $Reference)
    if ($DryRun) { return 'sha256:<identifiant-de-l-image>' }
    $id = ([string]$result.StdOut).Trim()
    if ($result.ExitCode -ne 0 -or $id -cnotmatch '^sha256:[0-9a-f]{64}\z') { throw ('Identifiant d image illisible : ' + $Reference) }
    return $id
}

function Invoke-OmoBuild([string]$Context, [string]$Tag) {
    Write-OmoLine ('image de base : ' + $BaseImage)
    return Invoke-OmoDocker -Stream -Arguments @('build', '--no-cache', '--progress=plain', '--provenance=false', '--build-arg', ('OPENCODE_BASE=' + $BaseImage),
        '--tag', $Tag, '--file', (Join-Path $Context 'Dockerfile'), $Context)
}

function Assert-OmoBuild($Result, [string]$Tag, [string]$LogFile) {
    if ($Result.ExitCode -ne 0) { throw ('Construction {0} en echec (code {1}). Journal : {2}' -f $Tag, $Result.ExitCode, $LogFile) }
    if ($DryRun) { return }
    $problems = @(Get-OmoBuildLogProblems $Result.Lines)
    if ($problems.Count -gt 0) { Write-OmoProblems $problems; throw ('Journal de npm ci refuse : aucun script de cycle de vie admis. Journal : ' + $LogFile) }
    Write-OmoLine 'journal : npm ci --ignore-scripts rejoue, aucun script de cycle de vie'
}

# Manifeste calcule DANS l'image, sans reseau, par le manifest.sh du contrat ; format et perimetre verifies.
function Get-OmoImageManifest([string]$Image, $Contract) {
    $result = Invoke-OmoDocker -Arguments (Get-OmoRunArguments $Image $Contract.Manifeste @())
    if ($DryRun) { return '' }
    if ($result.ExitCode -ne 0) { throw ('Calcul du manifeste en echec (code {0}).' -f $result.ExitCode) }
    $problems = @(Get-OmoManifestProblems $result.StdOut $Contract.Perimetre)
    if ($problems.Count -gt 0) { Write-OmoProblems $problems; throw 'Manifeste de l image hors format ou hors du perimetre du contrat.' }
    return [string]$result.StdOut
}

# La reference copiee dans l'image (lue par le superviseur) doit etre celle du depot.
function Assert-OmoEmbeddedReference([string]$Image, $Contract, [string]$Expected) {
    $result = Invoke-OmoDocker -Arguments (Get-OmoRunArguments $Image 'cat' @($Contract.Reference))
    if ($DryRun) { return }
    if ($result.ExitCode -ne 0 -or (Compare-OmoManifest $result.StdOut $Expected) -cne 'ok') { throw ('La reference copiee dans l image ({0}) differe de docker\opencode-omo\omo-manifest.sha256.' -f $Contract.Reference) }
    Write-OmoLine 'reference du manifeste dans l image = reference du depot'
}

# --- Etapes -------------------------------------------------------------------------------------------------------------------

function Assert-OmoDocker {
    $found = @(Get-Command docker -CommandType Application -ErrorAction SilentlyContinue | Where-Object { @('.exe', '.cmd', '.bat') -contains $_.Extension })
    if ($DryRun) {
        if ($found.Count -eq 0) { Write-OmoLine '[simulation] docker introuvable : la construction reelle s arreterait ici.' }
        return
    }
    if ($found.Count -eq 0) { throw 'Docker introuvable : installez ou demarrez Docker Desktop, puis relancez.' }
    $script:DockerPath = $found[0].Source
    if ((Invoke-OmoDocker -Arguments @('version', '--format', '{{.Server.Version}}')).ExitCode -ne 0) { throw 'Docker ne repond pas : demarrez Docker Desktop, puis relancez.' }
}

# D7 b : la base doit porter les drapeaux de la 1.0.6, lus sans reseau dans sa configuration (docker image inspect).
function Assert-OmoBaseFlags {
    $result = Invoke-OmoDocker -Arguments @('image', 'inspect', '--format', '{{json .Config.Env}}', $BaseImage)
    if ($DryRun) { Write-OmoLine '[simulation] drapeaux 1.0.6 de l image de base non verifies'; return }
    if ($result.ExitCode -ne 0) { throw ('Image de base introuvable sur ce poste : docker pull ' + $BaseImage + ', puis relancez.') }
    $problems = @(Get-OmoBaseFlagProblems ([string]$result.StdOut))
    if ($problems.Count -gt 0) {
        Write-OmoProblems $problems
        throw '-BaseImage refusee : l image de base ne porte pas les drapeaux de la 1.0.6 (OPENCODE_DISABLE_MODELS_FETCH=1, npm_config_offline=true). Construisez la salle sur l image opencode du cockpit 1.0.6 ou plus recente.'
    }
    Write-OmoLine 'image de base : drapeaux 1.0.6 presents (OPENCODE_DISABLE_MODELS_FETCH=1, npm_config_offline=true)'
}

function Assert-OmoFile([string]$Name) {
    $path = Join-Path $OmoDir $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('Fichier absent : docker\opencode-omo\' + $Name) }
    return $path
}

function Assert-OmoPackageFiles([switch]$WithoutLock) {
    $problems = @(Get-OmoPackageJsonProblems (Read-OmoText (Assert-OmoFile 'package.json')) $OmoPackage $OmoVersion)
    if (-not $WithoutLock) { $problems += @(Get-OmoLockfileProblems (Read-OmoText (Assert-OmoFile 'package-lock.json')) $OmoPackage $OmoVersion) }
    if ($problems.Count -gt 0) { Write-OmoProblems $problems; throw 'package.json ou package-lock.json refuse (voir ci-dessus).' }
}

function Resolve-OmoOutDir {
    $wanted = $OutDir
    if (-not $wanted) { $wanted = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'opencode-cockpit-omo' }
    $full = [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($wanted))
    if (Test-OmoInside $full $RepoRoot) { throw ('-OutDir refuse : {0} est dans le depot, qui est public. Choisissez un dossier hors du depot.' -f $full) }
    if ($DryRun) { Write-OmoLine ('[simulation] dossier de sortie : ' + $full) } else { [void][System.IO.Directory]::CreateDirectory($full) }
    return $full
}

function Invoke-OmoUpdateLock {
    Write-OmoStep 'Lockfile : npm install --package-lock-only --ignore-scripts, dans une copie temporaire'
    Assert-OmoPackageFiles -WithoutLock
    $lockFile = Join-Path $OmoDir 'package-lock.json'
    $work = New-OmoWorkDir 'lockfile'
    $packageHash = ''
    if (-not $DryRun) {
        Copy-OmoFileVerified (Join-Path $OmoDir 'package.json') (Join-Path $work 'package.json')
        if (Test-Path -LiteralPath $lockFile -PathType Leaf) { Copy-OmoFileVerified $lockFile (Join-Path $work 'package-lock.json') }
        $packageHash = Get-OmoSha256 (Join-Path $work 'package.json')
    }
    # D7 a : l'ENV d'une base 1.0.6 porte npm_config_offline=true ; neutralise pour ce seul conteneur (cache vide, sinon echec).
    $result = Invoke-OmoDocker -Stream -Arguments (@('run', '--rm') + $Hardening + @('-v', ($work + ':/omo-lock'), '-w', '/omo-lock', '-e', 'npm_config_offline=false', '--entrypoint', 'npm', $BaseImage,
        'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'))
    if ($DryRun) { Write-OmoLine ('[simulation] controle du lockfile produit, puis recopie verifiee vers ' + $lockFile); return }
    if ($result.ExitCode -ne 0) { throw ('npm install --package-lock-only en echec (code {0}).' -f $result.ExitCode) }
    if ((Get-OmoSha256 (Join-Path $work 'package.json')) -cne $packageHash) { throw 'npm a modifie package.json : lockfile refuse.' }
    $produced = Join-Path $work 'package-lock.json'
    if (-not (Test-Path -LiteralPath $produced -PathType Leaf)) { throw 'npm n a produit aucun package-lock.json.' }
    $problems = @(Get-OmoLockfileProblems (Read-OmoText $produced) $OmoPackage $OmoVersion)
    if ($problems.Count -gt 0) { Write-OmoProblems $problems; throw 'Lockfile produit refuse : docker\opencode-omo\package-lock.json inchange.' }
    Copy-OmoFileVerified $produced $lockFile
    Write-OmoLine ('lockfile ecrit : {0} (sha256 {1}). Relisez le diff, puis commitez-le.' -f $lockFile, (Get-OmoSha256 $lockFile))
}

# G14, dans des copies temporaires du contexte : le temoin doit se construire puis passer la validation sans reseau ; chaque
# mutation doit faire echouer la construction a l etape de validation, avec un message qui la cite.
function Invoke-OmoSelfTest($Contract, [string]$Stamp, [string]$Target) {
    Assert-OmoFile 'omo.jsonc' | Out-Null
    $root = New-OmoWorkDir 'selftest' -Create
    $verdicts = New-Object System.Collections.Generic.List[object]
    foreach ($case in @('temoin', 'hook-faux', 'cle-inconnue', 'valeur-retiree')) {
        Write-OmoStep ('Auto-test G14 : ' + $case)
        $context = Join-Path $root $case
        Copy-OmoContext $OmoDir $context
        if ($case -cne 'temoin') {
            $file = Join-Path $context 'omo.jsonc'
            Write-OmoFileVerified $file (Set-OmoSelfTestMutation (Read-OmoText $file) $case)
        }
        $tag = '{0}:selftest-{1}-{2}' -f $ImageRepository, $Stamp, $case
        $build = Invoke-OmoBuild $context $tag
        Save-OmoLog $Target ('{0}-{1}.selftest-{2}.log' -f $ArchiveBase, $Stamp, $case) $build.Lines
        if ($build.ExitCode -eq 0) { $script:TagsToRemove.Add($tag) }
        if ($case -ceq 'temoin') {
            $state = 'construction en echec'
            if ($build.ExitCode -eq 0) {
                $state = 'validation en echec'
                if ((Invoke-OmoDocker -Arguments (Get-OmoRunArguments $tag 'node' @($Contract.Valider, '--construction'))).ExitCode -eq 0) { $state = 'accepte' }
            }
        } elseif ($build.ExitCode -eq 0) { $state = 'accepte' }
        elseif (Test-OmoSelfTestRefusal $build.Lines $Contract.Valider (Get-OmoSelfTestMarker $case)) { $state = 'refuse par la validation' }
        else { $state = 'echec hors de la validation' }
        $verdicts.Add([pscustomobject]@{ Cas = $case; Etat = $state })
    }
    if ($DryRun) { Write-OmoLine '[simulation] verdicts non evalues : aucune construction lancee.'; return }
    Write-OmoStep 'Auto-test G14 : verdicts'
    foreach ($verdict in $verdicts) { Write-OmoLine ('{0} : {1}' -f $verdict.Cas, $verdict.Etat) }
    if (@($verdicts | Where-Object { $_.Cas -ceq 'temoin' -and $_.Etat -cne 'accepte' }).Count -gt 0) { throw 'Temoin en echec : l auto-test ne prouve rien (voir son journal).' }
    $accepted = @($verdicts | Where-Object { $_.Cas -cne 'temoin' -and $_.Etat -ceq 'accepte' } | ForEach-Object { $_.Cas })
    if ($accepted.Count -gt 0) { throw ('G14 en echec : construction acceptee malgre la mutation : ' + ($accepted -join ', ')) }
    $unproven = @($verdicts | Where-Object { $_.Cas -cne 'temoin' -and $_.Etat -cne 'refuse par la validation' } | ForEach-Object { $_.Cas })
    if ($unproven.Count -gt 0) { throw ('Auto-test non concluant : echec hors de l etape de validation, ou sans message citant la mutation : ' + ($unproven -join ', ')) }
    Write-OmoLine 'G14 vert : temoin accepte ; hook faux, cle inconnue et valeur epinglee retiree refuses par la validation de la construction.'
}

# D-2b-32 : construction 1, extraction, ecriture de la reference, construction 2, manifeste identique exige.
function Invoke-OmoBootstrap($Contract, [string]$Tag, [string]$Name, [string]$Target) {
    $referenceFile = Join-Path $OmoDir 'omo-manifest.sha256'
    $previous = [System.IO.File]::ReadAllBytes($referenceFile)
    $firstTag = $Tag + '-construction1'
    Write-OmoStep 'Amorcage (D-2b-32) : construction 1 sur 2, sans cache'
    $first = Invoke-OmoBuild $OmoDir $firstTag
    Save-OmoLog $Target ($Name + '.construction1.log') $first.Lines
    Assert-OmoBuild $first $firstTag (Join-Path $Target ($Name + '.construction1.log'))
    $script:TagsToRemove.Add($firstTag)
    Write-OmoStep 'Amorcage : manifeste de la construction 1, sans reseau'
    $lines = @(Get-OmoManifestLines (Get-OmoImageManifest (Get-OmoImageId $firstTag) $Contract))
    $header = @(('# Reference du manifeste de l image opencode-omo {0} (D-2b-32), ecrite par build-omo-image.ps1 -AcceptManifest.' -f $OmoVersion), ('# Image de base : ' + $BaseImage))
    $referenceText = ((@($header) + $lines) -join "`n") + "`n"
    if ($DryRun) { Write-OmoLine ('[simulation] ecriture de la reference : ' + $referenceFile) }
    else { Write-OmoFileVerified $referenceFile $referenceText; Write-OmoLine ('reference ecrite ({0} lignes), verifiee par empreinte : {1}' -f $lines.Count, $referenceFile) }
    $restore = -not $DryRun
    try {
        Write-OmoStep 'Amorcage : construction 2 sur 2, sans cache'
        $second = Invoke-OmoBuild $OmoDir $Tag
        Save-OmoLog $Target ($Name + '.construction.log') $second.Lines
        Assert-OmoBuild $second $Tag (Join-Path $Target ($Name + '.construction.log'))
        $imageId = Get-OmoImageId $Tag
        Write-OmoStep 'Amorcage : manifeste de la construction 2, identique exige'
        $manifest = Get-OmoImageManifest $imageId $Contract
        if (-not $DryRun -and (Compare-OmoManifest $manifest $referenceText) -cne 'ok') { throw 'Manifestes differents entre les deux constructions : construction non reproductible, reference refusee.' }
        Assert-OmoEmbeddedReference $imageId $Contract $referenceText
        $restore = $false
    } finally {
        if ($restore) {
            Write-OmoBytesVerified $referenceFile $previous
            Write-Host ('   reference precedente restauree, verifiee par empreinte : ' + $referenceFile) -ForegroundColor Red
        }
    }
    if ($DryRun) { Write-OmoLine '[simulation] comparaison des deux manifestes non faite : aucune construction lancee.' }
    else { Write-OmoLine 'manifeste identique sur les deux constructions ; relisez puis commitez docker\opencode-omo\omo-manifest.sha256.' }
    return $imageId
}

function Invoke-OmoAudit([object[]]$Accepted, [string]$AuditFile) {
    Write-OmoStep 'npm audit --omit=dev, compare a audit-baseline.json (npm de l image de base, lockfile en lecture seule)'
    $work = New-OmoWorkDir 'audit'
    if (-not $DryRun) {
        foreach ($name in @('package.json', 'package-lock.json')) { Copy-OmoFileVerified (Join-Path $OmoDir $name) (Join-Path $work $name) }
    }
    # D7 a : l'ENV d'une base 1.0.6 porte npm_config_offline=true ; hors ligne, npm audit n'interroge pas le registre et rend un
    # rapport valide et VIDE en code 0, que le verdict accepterait. Neutralise pour ce seul conteneur, comme pour le lockfile.
    $result = Invoke-OmoDocker -Arguments (@('run', '--rm') + $Hardening + @('-v', ($work + ':/omo-audit:ro'), '-w', '/omo-audit', '-e', 'npm_config_offline=false', '--entrypoint', 'npm', $BaseImage,
        'audit', '--omit=dev', '--json'))
    if ($DryRun) { return }
    Write-OmoFileVerified $AuditFile ([string]$result.StdOut)
    $verdict = Get-OmoAuditVerdict $result.StdOut $Accepted
    if ($verdict.Probleme) { throw ('Audit npm inexploitable : {0}. Rapport : {1}' -f $verdict.Probleme, $AuditFile) }
    foreach ($label in $verdict.Acceptees) { Write-OmoLine ('alerte haute acceptee par audit-baseline.json : ' + $label) }
    if (@($verdict.Nouvelles).Count -gt 0) { Write-OmoProblems $verdict.Nouvelles; throw ('Alerte haute nouvelle : construction arretee. Rapport : ' + $AuditFile) }
    Write-OmoLine ('aucune alerte haute nouvelle ({0} alerte(s) basse(s) ou moderee(s)) ; rapport : {1}' -f $verdict.Mineures, $AuditFile)
}

function Invoke-OmoSbom([string]$ImageId, $Contract, [string]$SbomFile) {
    Write-OmoStep 'SBOM : npm ls --all --json dans l image, sans reseau'
    $result = Invoke-OmoDocker -Arguments (Get-OmoRunArguments $ImageId 'npm' @('ls', '--all', '--json', '--omit=dev', '--prefix', $Contract.Extension))
    if ($DryRun) { return }
    if ($result.ExitCode -ne 0) { throw ('npm ls signale un arbre incoherent (code {0}).' -f $result.ExitCode) }
    $tree = $null
    try { $tree = ConvertFrom-Json $result.StdOut } catch { $tree = $null }
    if ((Get-OmoProp (Get-OmoProp (Get-OmoProp $tree 'dependencies') $OmoPackage) 'version') -cne $OmoVersion) { throw ('SBOM sans {0} {1}.' -f $OmoPackage, $OmoVersion) }
    Write-OmoFileVerified $SbomFile ([string]$result.StdOut)
    Write-OmoLine ('SBOM : ' + $SbomFile)
}

function Invoke-OmoValidation([string]$ImageId, $Contract, [string]$Target, [string]$Name) {
    # --construction : controles de l'image seule ; ceux du demarrage (~/.omo/omo.jsonc monte, adresse Copilot) sont faits par
    # le superviseur a chaque lancement de la salle (validate.mjs de L15a).
    Write-OmoStep ('Validation (JS-5, G14) : node {0} --construction, sans reseau' -f $Contract.Valider)
    $result = Invoke-OmoDocker -Arguments (Get-OmoRunArguments $ImageId 'node' @($Contract.Valider, '--construction'))
    if ($DryRun) { return }
    Save-OmoLog $Target ($Name + '.validation.log') (@($result.Lines) + @(([string]$result.StdOut) -split "`r?`n"))
    foreach ($line in @(([string]$result.StdOut) -split "`r?`n") + @($result.Lines)) { if ($line) { Write-OmoLine ('| ' + (Get-OmoSafeText $line 200)) } }
    if ($result.ExitCode -ne 0) { throw ('Validation en echec (code {0}) : configuration refusee.' -f $result.ExitCode) }
}

function Save-OmoArchive([string]$Tag, [string]$ImageId, [string]$Name, [string]$Target) {
    Write-OmoStep 'Archive : docker save, gzip, empreintes'
    $tar = Join-Path $Target ($Name + '.tar')
    $archive = Join-Path $Target ($Name + '.tar.gz')
    $checksum = $archive + '.sha256'
    if (-not $DryRun) { foreach ($file in @($tar, $archive, $checksum)) { if (Test-Path -LiteralPath $file) { throw ('Fichier deja present, jamais ecrase : ' + $file) } } }
    if ((Get-OmoImageId $Tag) -cne $ImageId) { throw 'L etiquette ne designe plus l image verifiee : archive refusee.' }
    $result = Invoke-OmoDocker -Arguments @('save', '--output', $tar, $Tag)
    if ($DryRun) { Write-OmoLine ('[simulation] compression de {0} vers {1}, empreintes Get-FileHash, puis {2}' -f $tar, $archive, $checksum); return $null }
    # Un echec apres docker save ne laisse aucun fichier partiel ou non verifie dans le dossier de sortie.
    $done = $false
    try {
        if ($result.ExitCode -ne 0) { throw ('docker save en echec (code {0}).' -f $result.ExitCode) }
        if ((Get-OmoImageId $Tag) -cne $ImageId) { throw 'L etiquette a change pendant docker save : archive refusee.' }
        Compress-OmoGzip $tar $archive
        if (-not (Test-OmoGzipRoundTrip $tar $archive)) { throw ('Archive compressee differente de la sortie de docker save : ' + $archive) }
        [System.IO.File]::Delete($tar)
        $sha = Get-OmoSha256 $archive
        Write-OmoFileVerified $checksum (Format-OmoChecksumFile (Split-Path -Leaf $archive) $sha $ImageId $Tag)
        $done = $true
    } finally {
        if (-not $done) { foreach ($file in @($tar, $archive, $checksum)) { if (Test-Path -LiteralPath $file) { [System.IO.File]::Delete($file) } } }
    }
    return [pscustomobject]@{ Archive = $archive; Checksum = $checksum; Sha256 = $sha }
}

function Invoke-OmoMain {
    if (@(@($UpdateLock.IsPresent, $SelfTest.IsPresent, $AcceptManifest.IsPresent) | Where-Object { $_ }).Count -gt 1) {
        throw '-UpdateLock, -SelfTest et -AcceptManifest ne se combinent pas : lancez-les l un apres l autre.'
    }
    if (-not $BaseImage) { throw '-BaseImage est obligatoire : l image opencode du cockpit epinglee par empreinte, <nom>@sha256:<64 hex>.' }
    if (-not (Test-OmoBaseImage $BaseImage)) {
        throw ('-BaseImage refusee : une empreinte @sha256:<64 caracteres hexadecimaux en minuscules> est obligatoire (une etiquette seule peut changer de contenu). Recu : ' + (Get-OmoSafeText $BaseImage 120))
    }
    if ($DryRun) { Write-Host '[simulation] aucune commande docker n est lancee ; rien n est ecrit dans le depot ni dans le dossier de sortie.' -ForegroundColor Yellow }
    Assert-OmoDocker
    Assert-OmoBaseFlags
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss', [System.Globalization.CultureInfo]::InvariantCulture)
    if ($UpdateLock) { Invoke-OmoUpdateLock; return }
    $contract = Read-OmoContract (Read-OmoText (Assert-OmoFile 'contrat-salle.json'))
    Assert-OmoFile 'Dockerfile' | Out-Null
    Assert-OmoPackageFiles
    $target = Resolve-OmoOutDir
    if ($SelfTest) { Invoke-OmoSelfTest $contract $stamp $target; return }
    $accepted = Read-OmoBaseline (Read-OmoText (Assert-OmoFile 'audit-baseline.json')) $OmoPackage $OmoVersion
    $referenceText = Read-OmoText (Assert-OmoFile 'omo-manifest.sha256')
    if (-not $AcceptManifest) {
        if (Test-OmoAmorce $referenceText) { throw 'omo-manifest.sha256 est encore l amorce : lancez d abord ce script avec -AcceptManifest (D-2b-32).' }
        $problems = @(Get-OmoManifestProblems $referenceText $contract.Perimetre)
        if ($problems.Count -gt 0) { Write-OmoProblems $problems; throw 'omo-manifest.sha256 hors format : relancez -AcceptManifest.' }
    }
    $name = '{0}-{1}' -f $ArchiveBase, $stamp
    $tag = '{0}:{1}-{2}' -f $ImageRepository, $OmoVersion, $stamp
    if ($AcceptManifest) { $imageId = Invoke-OmoBootstrap $contract $tag $name $target }
    else {
        Write-OmoStep 'Construction sans cache'
        $build = Invoke-OmoBuild $OmoDir $tag
        Save-OmoLog $target ($name + '.construction.log') $build.Lines
        Assert-OmoBuild $build $tag (Join-Path $target ($name + '.construction.log'))
        $imageId = Get-OmoImageId $tag
    }
    Invoke-OmoAudit $accepted (Join-Path $target ($name + '.audit.json'))
    Invoke-OmoSbom $imageId $contract (Join-Path $target ($name + '.sbom.json'))
    Invoke-OmoValidation $imageId $contract $target $name
    if (-not $AcceptManifest) {
        Write-OmoStep 'Manifeste compare a docker\opencode-omo\omo-manifest.sha256, sans reseau'
        $manifest = Get-OmoImageManifest $imageId $contract
        if (-not $DryRun -and (Compare-OmoManifest $manifest $referenceText) -cne 'ok') { throw 'Manifeste de l image different de la reference commitee : image refusee (relisez le diff avant tout -AcceptManifest).' }
        Assert-OmoEmbeddedReference $imageId $contract $referenceText
    }
    $saved = Save-OmoArchive $tag $imageId $name $target
    if ($DryRun) { Write-OmoStep 'Simulation terminee : aucune image construite, aucune archive ecrite'; return }
    Write-OmoStep 'Termine'
    Write-OmoLine ('archive   : ' + $saved.Archive)
    Write-OmoLine ('empreinte : {0} (fichier {1})' -f $saved.Sha256, $saved.Checksum)
    Write-OmoLine ('image     : {0} ({1})' -f $tag, $imageId)
    Write-OmoLine ('audit, SBOM et journaux : ' + $target)
    Write-OmoLine 'Ne publiez jamais cette archive : copiez-la avec son .sha256 vers le poste de travail, puis install.ps1 -OmoArchive.'
}

$exitCode = 1
try {
    Invoke-OmoMain
    $exitCode = 0
} catch {
    Write-Host ('ARRET : ' + (Hide-OmoSecrets $_.Exception.Message)) -ForegroundColor Red
} finally {
    foreach ($tag in @($script:TagsToRemove)) {
        try { if ((Invoke-OmoDocker -Arguments @('image', 'rm', $tag)).ExitCode -ne 0) { Write-Host ('   image intermediaire gardee : ' + $tag) } }
        catch { Write-Host ('   image intermediaire gardee : {0} ({1})' -f $tag, $_.Exception.Message) }
    }
    Remove-OmoWorkDirs @($script:TempDirs)
}
exit $exitCode
