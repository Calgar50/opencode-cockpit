# Certificats d'entreprise (proxy TLS)

Les proxys d'entreprise inspectent souvent le trafic HTTPS : ils re-signent chaque
certificat avec **leur propre autorité racine**. Sans cette racine, les conteneurs
échouent avec `SELF_SIGNED_CERT_IN_CHAIN` / `unable to get local issuer certificate`.

## Méthode recommandée (TLS vérifié)

`install.ps1` exporte automatiquement les autorités racines et intermédiaires de
confiance du magasin Windows dans `certs/windows-trust.pem`. Les conteneurs les
ajoutent à leur magasin au démarrage (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
`GIT_SSL_CAINFO`) : la vérification TLS **reste active**.

Pour ajouter une autorité à la main, déposez son certificat **PEM** (texte commençant
par `-----BEGIN CERTIFICATE-----`) ici, avec l'extension `.pem` ou `.crt`, puis :

```powershell
.\cockpit.ps1 restart
```

Un fichier `.cer` binaire (DER) se convertit ainsi :

```powershell
certutil -encode .\racine.cer .\certs\racine.pem
```

## Méthode de secours (TLS non vérifié)

Uniquement si la méthode ci-dessus est impossible : `COCKPIT_TLS_INSECURE=1` dans `.env`.
La vérification des certificats est alors **désactivée** dans les deux conteneurs, et
un bandeau rouge le rappelle en permanence dans l'interface. Tout intermédiaire réseau
pourrait lire ou modifier le trafic, jeton Copilot compris.

> Ce dossier est ignoré par git (sauf ce README) : les certificats restent sur la machine.
