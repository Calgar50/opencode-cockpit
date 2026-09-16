# Certificats d'entreprise (proxy TLS)

Les proxys d'entreprise inspectent souvent le trafic HTTPS : ils re-signent chaque
certificat avec **leur propre autorité racine**. Sans cette racine, les conteneurs
échouent avec `SELF_SIGNED_CERT_IN_CHAIN` / `unable to get local issuer certificate`.

## Méthode recommandée (TLS vérifié)

`install.ps1` exporte automatiquement les autorités racines et intermédiaires de
confiance du magasin Windows dans `certs/windows-trust.pem`. Le conteneur opencode les
ajoute à son magasin au démarrage (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
`GIT_SSL_CAINFO`) : la vérification TLS **reste active**. Depuis la 1.0.1, le serveur du
cockpit les charge aussi pour ses appels sortants (liste des IA du compte, solde
facultatif).

Pour ajouter une autorité à la main, déposez son certificat **PEM** (texte commençant
par `-----BEGIN CERTIFICATE-----`) ici, avec l'extension `.pem` ou `.crt`, puis :

```powershell
.\cockpit.ps1 restart
```

Si l'erreur survient pendant la construction des images (npm, apt), relancez plutôt
`.\install.ps1` : les certificats sont intégrés aux images lors de leur construction.

Un fichier `.cer` binaire (DER) se convertit ainsi :

```powershell
certutil -encode .\racine.cer .\certs\racine.pem
```

## Méthode de secours (TLS non vérifié)

Uniquement si la méthode ci-dessus est impossible : `COCKPIT_TLS_INSECURE=1` dans `.env`.
La vérification des certificats est alors **désactivée** dans le conteneur opencode, et
un bandeau rouge le rappelle en permanence dans l'interface. Tout intermédiaire réseau
pourrait lire ou modifier le trafic, jeton Copilot compris.

## Ne déposez jamais ici le certificat ni la clé du cockpit

Ce dossier est monté dans le conteneur de l'agent, et **chaque certificat qui s'y trouve
devient une autorité de confiance** pour opencode. Il n'est destiné qu'aux autorités du
proxy d'entreprise, pour le trafic **sortant**.

Le certificat HTTPS local du cockpit (`https://127.0.0.1:7777`) est ailleurs : dans le
volume Docker `cockpit-tls`, monté uniquement dans le conteneur du cockpit. Il est créé et
renouvelé tout seul ; `.\cockpit.ps1 tls` l'affiche, `.\cockpit.ps1 tls -Renew` le
remplace.

> Ce dossier est ignoré par git (sauf ce README) : les certificats restent sur la machine.
