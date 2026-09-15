# Banc PowerShell 5.1 du cockpit (`tests/ps51`)

Tests des scripts Windows (`install.ps1`, `cockpit.ps1`, `CockpitTls.ps1`) sous **Windows PowerShell 5.1**, sans Pester, lancés par le job CI `windows-ps51` (`windows-2025`, Node 24).

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/ps51/Validate-Scripts.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/ps51/Test-CockpitTls.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/ps51/Test-Install.ps1   # lot 6
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/ps51/Test-Cockpit.ps1   # lot 7
```

`Test-CockpitTls.ps1 -FailFast` s'arrête au premier échec (nettoyage compris) : utile pour une campagne de mutations.

Ce banc est un **contrat** : les lots 6 et 7 l'utilisent tel quel, sans le modifier. Un besoin nouveau passe par un lot dédié.

## Règles communes

- Scripts `.ps1` en ASCII pur avec BOM UTF-8 et fins de ligne CRLF ; `Set-StrictMode -Version 2.0` ; aucun `Invoke-Expression`.
- Aucun secret réel : jeton aléatoire propre à l'exécution (`New-CockpitChallenge`), jamais affiché ; rotation vérifiée par condensé.
- Tout est écrit dans un dossier temporaire supprimé en `finally`. Registre : seulement `HKCU:\Software\opencode-cockpit-test`, supprimé en `finally` ; **jamais** `SOFTWARE\Policies`.
- Aucun crochet de test dans les scripts livrés : espions par fonctions homonymes, paramètres facultatifs dont le défaut est le comportement livré (`-CurlPath`, `-RegistryRoots`, `-Scopes`), jamais une variable d'environnement.
- Jamais le port 7777 ni les conteneurs, volumes et images de l'utilisateur.
- **Piège P5** : sous `$ErrorActionPreference = 'Stop'`, une ligne stderr d'un appel natif par `&` lève `NativeCommandError`. curl et git passent toujours par `Invoke-CockpitProcess`.
- **Piège PS 5.1** : `ConvertFrom-Json` rend un tableau JSON de premier niveau comme **un seul** objet ; `return , $tableau` suivi de `@(...)` l'enveloppe dans un tableau d'un élément.

## `Validate-Scripts.ps1`

Règles statiques du plan (§3.7.8), par l'arbre syntaxique (`Parser::ParseFile`), puis un auto-test qui injecte chaque motif interdit dans une copie temporaire et vérifie qu'il est détecté.

- `-Path` : fichiers relatifs à la racine du dépôt (défaut : `install.ps1`, `cockpit.ps1`, `CockpitTls.ps1`) ; les règles dépendent du **nom** du fichier. `-SkipSelfTest` saute l'auto-test.
- Code de sortie 0 seulement si chaque fichier est conforme **et** l'auto-test est vert.

| Règle | Contenu |
|---|---|
| `encodage`, `analyse` | BOM, 0 octet non ASCII, 0 caractère de contrôle, CRLF, `ParseFile` sans erreur |
| `url-litterale` | `://127.0.0.1` ou `://localhost` (quel que soit le schéma, adresse assemblée comprise) seulement dans `Get-CockpitBaseUrl` et `Get-CockpitBrowserTlsPolicy` |
| `interdit` | `Invoke-WebRequest`, `Invoke-RestMethod`, `ServicePointManager`, `DefaultWebProxy`, `SecurityProtocol`, `SkipCertificateCheck`, `-k`, `--insecure`, `Import-Certificate`, `certutil`, `X509Store`, `Invoke-Expression` ; `Cert:\` et `.Thumbprint` seulement dans la fonction `Export-WindowsCertificates` ou le cas `'certs'` du `switch` de `cockpit.ps1` |
| `add-type` | seulement dans `Initialize-CockpitPinnedHttp` (`CockpitTls.ps1`) |
| `read-host` | liste fermée d'invites (début du texte) : `install.ps1` « Dossier de vos projets », « Le dossier ' », « Continuer quand meme ? » ; `cockpit.ps1` « Tapez RESTAURER / SUPPRIMER / RENOUVELER / REVENIR pour confirmer » ; `CockpitTls.ps1` « Tapez HTTP EN CLAIR pour confirmer » dans `Confirm-CockpitHttpMode` |
| `appel-natif` | `curl`, `git`, `iex`, `iwr`, `irm` jamais appelés directement (ni `& $curl`, ni `& "<dossier>\curl.exe"`) ; `docker` seulement dans `Invoke-Docker`, `Get-DockerOutput`, `Invoke-DockerTimeout`, `Get-ArchiveDir`, `Invoke-CockpitDocker` ; `ProcessStartInfo` et `[System.Diagnostics.Process]` seulement dans `Invoke-CockpitProcess` et ces fonctions |

Un nom de commande qualifié compte comme le nom seul : `Microsoft.PowerShell.Utility\Read-Host`, `C:\Windows\System32\curl.exe`.
| `docker-isolation` | ces fonctions appellent `Invoke-CockpitDocker`, ou `ConvertTo-CockpitDockerArgs` avec `Clear-CockpitComposeEnv` (ou `$CockpitComposeEnvNames`) |
| `compose-variables` | `$CockpitComposeEnvNames` contient chaque `${NOM` de `docker-compose.yml` et `COMPOSE_FILE`, `COMPOSE_ENV_FILES`, `COMPOSE_PROFILES` |
| `docker-inspect` | `.Config.Env` seulement dans `Get-CockpitImageVersion` |
| `parametres` | `install.ps1` : paramètres de la 1.0.4 + `Http`, `Https`, `TlsPreflight`, `AcceptBrowserBlock`, rien d'autre ; `cockpit.ps1` : `Command`, `Target`, `Purge`, `[switch]Renew`, `ValidateSet` de la 1.0.4 + `tls`, `rollback` |
| `sauvegarde` | aucun montage `cockpit-tls:` dans le cas `'backup'` |
| `taille` | `CockpitTls.ps1` : 660 lignes au plus |

## `CockpitTls.ps1` : signatures utilisées par les lots 6 et 7

L'en-tête du fichier fait foi. `$Mode` vaut `'https'`, `'http'` ou l'objet rendu par `Get-CockpitLocalMode`.

- `Get-CockpitLocalMode $Config` → `{ Scheme ; ConfirmedAt ; Raw ; Valid ; Problem }`, sans exception, `Problem` sans la valeur lue.
- `Get-CockpitTransition -Mode -IsNew <bool> -IsMigration <bool> [-Http] [-Https]` → `EntreeHttps | EntreeHttp | ResteHttps | ResteHttp | Invalide`.
- `Get-CockpitPrecheckProblems -Transition -Mode -Policy -AcceptBrowserBlock <bool> -IsMigration <bool> -LoadProblem <texte> -Port -Version -PreviousVersion` → `{ Problems ; Warnings }`, chacun une liste de `{ Code ; Lines }` dans l'ordre d'affichage (`A18|A2`, `A-Load`, `A2-Load`, `A2-Update` ; `A2-Reste`, `AcceptBrowserBlock`, `AVerifier`, `Couvert`). `Problems` non vide : `Warnings` est vide (A2-Reste « la mise a jour continue » contredirait l'arrêt) ; afficher `Problems` avec `Write-CockpitLines`, puis un seul `throw $CockpitA19`. Sinon : afficher `Warnings` et continuer.
- `Wait-CockpitHealth -Root -Port -Mode -Token [-TimeoutSec 240] [-Methods] [-CurlPath] [-PollSec 2] [-TlsState]` → `{ Reason ; Method ; Status ; Version ; Detail ; Ticket ; Retry ; TlsState ; ContainerHealth }`. `-Root ''` : aucun appel docker (tests).
- `Test-CockpitHealth -Port -Mode -Token -TlsState [-Methods] [-ContainerHealthy] [-WithTicket] [-CurlPath] [-TimeoutSec]` : un seul essai.
- `Get-CockpitLoginUrl -Health -Port -Mode -Token [-TlsState] [-CurlPath]` → `{ Url ; Reason ; Detail }` ; l'URL n'est jamais affichée.
- `Get-CockpitOpenDecision -Health -Mode -Policy` → `{ Decision = Open | NotOk ; Lines }` (A2-Open).
- `Get-CockpitBrowserTlsPolicy -Port [-RegistryRoots <[ordered]@{ HKLM = '<chemin>'; HKCU = '<chemin>' }>]` → `{ Verdict ; Source ; Value ; Origins ; Origin ; Port ; Chrome ; HttpsOnly }`.
- Messages : `Write-CockpitModeNotice -Mode -Policy [-OneLine]` (A6, A6-1, A6b), `Confirm-CockpitHttpMode -Port -Policy` (A5 + saisie), `Write-CockpitLines`.
- Docker : `Invoke-CockpitDocker -Root -DockerArgs -TimeoutSec`, `ConvertTo-CockpitDockerArgs`, `Clear-CockpitComposeEnv` / `Restore-CockpitComposeEnv` (appels par `&`), `Get-CockpitComposeProjectName`, `Get-CockpitComposeDivergence`, `Get-CockpitImageVersion` (`[version]` ou `$null`), `Get-CockpitServedScheme` (`https`, `http`, `inconnu` pour une valeur hors liste jamais recopiée, `$null` si illisible), `Get-CockpitContainerHealth`, `Read-CockpitTlsPublic`.
- Valeurs venues du réseau : `Version` de la santé ne garde que `[0-9A-Za-z.+-]`, 32 caractères au plus ; `Detail` passe par `Hide-Secrets`.
- Divers : `Invoke-CockpitProcess -FilePath <absolu> -Arguments -TimeoutSec -RemoveEnv`, `Hide-Secrets`, `Assert-CockpitFullLanguage`, `Get-CockpitBaseUrl`, `Get-CockpitHmacHex`, `Test-CockpitGeneratedToken`, `Get-CockpitPortOwner`, `Format-CockpitFingerprint`, `Get-CockpitCertWarnings`, `Get-CockpitCurl`.

## Faux docker (`fake-docker/`)

`docker.cmd` lance `fake-docker.ps1`. Mettre le dossier **en tête du `PATH` du processus de test** : `Invoke-CockpitDocker` résout `docker` en `.exe`, `.cmd` ou `.bat` (le fichier `docker` sans extension de Docker Desktop est ignoré), et `& docker` trouve aussi `docker.cmd`.

Scénario JSON, désigné par la variable `COCKPIT_TEST_DOCKER_SCENARIO` (absente de `$CockpitComposeEnvNames`, donc jamais masquée) :

```json
{
  "journal": "C:\\...\\journal.jsonl",
  "rules": [
    { "match": "^compose -f \\S.* ps -q cockpit$", "stdout": "0123456789abcdef\n", "code": 0 },
    { "match": "^inspect --format \\{\\{\\.State\\.Health\\.Status\\}\\} 0123456789abcdef$", "stdout": "healthy\n" },
    { "match": "^compose -f \\S.* exec -T cockpit cat /tls/public/cockpit\\.crt$", "stdoutFile": "C:\\...\\A.crt" },
    { "match": "^load ", "fail": true },
    { "match": "^image inspect ", "stdout": "COCKPIT_VERSION=1.0.4\n", "uses": 1, "sleepMs": 0 }
  ]
}
```

- `match` : expression régulière **sensible à la casse** sur les arguments joints par une espace ; règles essayées dans l'ordre ; une règle dont `uses` est épuisé est sautée (compteurs dans `<scenario>.state.json`).
- `stdout` / `stdoutFile`, `stderr`, `code` (défaut 0), `sleepMs` ; `"fail": true` = appel interdit (code 97, `forbidden` au journal). Aucune règle : code 99. Scénario absent : code 98.
- Journal JSONL (défaut `<scenario>.jsonl`), une ligne par appel : `args` (tableau exact), `env` (**noms** des variables de `$CockpitComposeEnvNames` présentes, jamais les valeurs), `rule`, `code`, `forbidden`.
- Arguments relus dans la ligne de commande brute selon les règles de `CommandLineToArgvW` (celles de `docker.exe`). Mesuré (M-FAKEDOCKER) : formats Go à espaces, `--format json`, `-f` vers un chemin à espaces, argument vide, barre oblique finale, `&`, `@{u}` et chemin UNC arrivent intacts par `Invoke-CockpitDocker`.
- **Limite** : un argument qui contient un guillemet `"` n'est pas transmis correctement à travers `cmd.exe` ; `& docker` sous PS 5.1 perd aussi les arguments vides. Les commandes docker des scripts n'en contiennent pas.
- Chaque appel coûte environ 0,5 s (démarrage de `powershell.exe`).
- Contrat vérifié en CI par `Test-CockpitTls.ps1` (lignes « banc : ») : résolution par `& docker`, arguments intacts, code, stdout et stderr propagés, `uses`, appel interdit (97), appel sans règle (99), journal sans valeurs.

Motifs types pour les commandes des scripts (chaînes PowerShell entre apostrophes ; `Invoke-CockpitDocker` insère `-f <dossier>\docker-compose.yml` après `compose`). Le journal donne les arguments exacts reçus quand un motif ne correspond pas.

| Commande | Motif |
|---|---|
| `docker version`, `docker compose version` | `'^version'`, `'^compose version'` |
| `compose config --format json` | `'^compose -f \S.* config --format json$'` |
| `compose ps -q cockpit` | `'^compose -f \S.* ps -q cockpit$'` |
| `compose up`, `pull`, `build`, `stop`, `logs` | `'^compose -f \S.* up\b'`, `'^compose -f \S.* pull\b'`, de même pour `build`, `stop` et `logs` |
| `compose exec` (valeur demandée seule, fichiers publics) | `'^compose -f \S.* exec -T cockpit printenv COCKPIT_LOCAL_SCHEME$'`, `'^compose -f \S.* exec -T cockpit cat /tls/public/cockpit\.crt$'` avec `stdoutFile` |
| santé du conteneur | `'^inspect --format \{\{\.State\.Health\.Status\}\} '` |
| variables et identifiant d'une image | `'^image inspect --format \{\{range \.Config\.Env\}\}\{\{println \.\}\}\{\{end\}\} '`, `'^image inspect --format \{\{\.Id\}\} '` |
| `load`, `run`, `volume` | `'^load '`, `'^run '`, `'^volume '` |
| appel qui ne doit jamais avoir lieu | `{ "match": "^load ", "fail": true }` |

## Espions (`Spies.ps1`)

Charger par dot-sourcing dans la portée qui appelle le script testé (par exemple dans une fonction, pour qu'ils disparaissent ensuite). L'état est l'objet `$SpyState`, lu par une **variable non qualifiée** : un `$script:` y vaudrait `$null` dans un script appelé par `&` (P6).

- `Read-Host` : réponses en file (`Add-SpyReadHostAnswer 'HTTP EN CLAIR'`, `Add-SpyReadHostAnswer $null` pour une entrée vide, `Add-SpyReadHostAnswer $SpyNonInteractive` pour l'exception de `-NonInteractive`) ; invites dans `$SpyState.ReadHostCalls` ; file vide = exception « aucune reponse prevue ».
- `Start-Process` : consigné dans `$SpyState.StartProcessCalls` (`FilePath`, `ArgumentList`), jamais affiché.
- `Get-ItemProperty`, `Test-Path` : clés `HKLM|HKCU:\SOFTWARE\Policies\...` simulées par `Set-SpyPolicy -Hive HKLM -Browser Edge|Chrome -Name <valeur> -Value <v> [-Origins @(...)]` ; lectures dans `$SpyState.PolicyReads` ; tout autre chemin est délégué à `Microsoft.PowerShell.Management\...`.
- `Reset-SpyState` vide l'état.
- Vérifié par `Test-CockpitTls.ps1` : les espions restent actifs dans un script appelé par `&` qui a son propre `param` et `Set-StrictMode`, et disparaissent à la sortie de la fonction qui les a chargés.

## Serveur de test (`srv-test.mjs`)

`node tests/ps51/srv-test.mjs <config.json>` (Node 24, aucune dépendance). Écoute `127.0.0.1` seulement, port 0 par défaut (7777 refusé), annonce `{"ready":true,"ports":{"<nom>":<port>}}` sur une ligne de stdout, s'arrête à la fermeture de stdin (lancer avec `RedirectStandardInput` et fermer en `finally`).

```json
{
  "certDir": "<dossier de New-TestCerts.ps1>",
  "envFile": "<.env de test, facultatif>",
  "behaviorFile": "<fichier relu a chaque requete, facultatif>",
  "logFile": "<journal JSONL sans valeurs, facultatif>",
  "listeners": [
    { "name": "A", "kind": "https", "cert": "A" },
    { "name": "A12", "kind": "https", "cert": "A", "maxVersion": "TLSv1.2" },
    { "name": "close", "kind": "close" },
    { "name": "plain", "kind": "http", "behavior": { "proof": "bad" } }
  ]
}
```

- `kind` : `https` (certificat `<cert>.crt` / `<cert>.key`), `http`, `close` (accepte puis ferme) ou `hang` (accepte et ne répond jamais).
- `/api/health` : `{ ok, version, scheme, proof?, ticket? }`. Jeton et schéma attendus : relus **à chaque requête** dans `envFile` (`COCKPIT_TOKEN`, `COCKPIT_LOCAL_SCHEME`, vide = `https`) ; sans `envFile`, jeton de la variable `SRV_TEST_TOKEN` et schéma de l'écouteur.
- Comportement (`behavior` de l'écouteur, complété par `behaviorFile` sous la clé du nom) : `scheme` (`https`, `http`, `none` = réponse 1.0.4 sans schéma), `proof` (`good`, `upper` = bonne valeur en majuscules, `bad`, `absent`, `null`), `ticket` (`good`, `bad`, `none`), `status`, `version`, `raw` (corps brut), `redirect` (302 vers `/redirige`, qui répond comme une santé normale : un client qui suit les redirections y arrive). Défaut : preuve bonne si le jeton a le format généré, sinon `null`.
- Défi mal formé : 400. `logFile` : `{ listener, path, challenge, ticket, t, k }` en booléens, jamais de valeur.

## Certificats de test (`New-TestCerts.ps1`)

`& tests/ps51/New-TestCerts.ps1 -Directory <dossier sous %TEMP%> [-Names A,B,expire,dns]` : clé CNG ECDSA P-256 **éphémère** et `CertificateRequest` .NET 4.8, mêmes extensions que le serveur (SAN, `CA:FALSE`, `digitalSignature`, `serverAuth`). Écrit `<nom>.crt` et `<nom>.key` (PKCS#8, lu par Node) et rend `{ Name ; PemText ; JsonText ; Sha256Hex }`, `JsonText` reproduisant `public/cockpit-tls.json`. `A` et `B` : valables 397 jours ; `expire` : 2024-01-01 → 2025-01-01 ; `dns` : SAN `DNS:cockpit.example` seul. Dossier hors de `%TEMP%` refusé ; jamais de magasin Windows.

> Piège mesuré : `[CngKey]::Create($alg, $null, $params)` en PowerShell passe `""` et crée une clé **persistante** nommée `""` dans le magasin de l'utilisateur. Toujours `[NullString]::Value`, et vérifier `IsEphemeral`.

## Faux curl (`fake-curl/`)

- `curl755.cmd` : répond `curl 7.55.1 ... WinSSL` (trop ancien : voie C#).
- `curl-openssl.cmd` : répond `curl 8.9.0 ... OpenSSL` (sans Schannel).
- `curl-log.cmd` : consigne ses arguments (un tableau JSON par ligne dans le fichier `COCKPIT_TEST_CURL_LOG`), puis délègue au vrai `curl.exe` de Windows (Node requis).

À passer par `-CurlPath` ; jamais par le `PATH`.
