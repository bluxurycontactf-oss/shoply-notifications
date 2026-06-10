# Shoply Notifications Backend

Backend Node.js pour :
- l'envoi des notifications push FCM quand un nouveau produit est ajouté
- l'activation sécurisée des plans payants (vérification FedaPay côté serveur)
- le traitement sécurisé du programme de parrainage

## Variables d'environnement Render

| Variable | Valeur |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | JSON complet du compte de service Firebase (vendor-00), sur une seule ligne |
| `FEDAPAY_SECRET_KEY` | Clé secrète FedaPay (`sk_live_...`), pour vérifier les paiements |

## Déploiement sur Render

1. Pusher ce dossier sur GitHub (dépôt séparé ou sous-dossier)
2. Render → New Web Service → connecter le repo
3. Build command : `npm install`
4. Start command : `node index.js`
5. Ajouter les variables d'environnement `FIREBASE_SERVICE_ACCOUNT` et `FEDAPAY_SECRET_KEY`
6. Copier l'URL Render (ex: `https://shoply-notifications.onrender.com`)
7. Ajouter dans `.env.local` du projet frontend (`/home/didi/vendor/.env.local`) :
   `NEXT_PUBLIC_NOTIFY_API_URL=https://shoply-notifications.onrender.com`
8. Rebuild + redeploy le frontend (`npm run build` puis `firebase deploy --project vendor-00 --only hosting`)

## Endpoints

- `GET /` — health check
- `POST /notify-new-product` — envoie les pushs aux abonnés
- `POST /activate-plan` — active un plan Premium/Business après vérification du paiement FedaPay
  - Headers: `Authorization: Bearer <Firebase ID token>`
  - Body: `{ shopId, plan: 'premium'|'business', transactionId }`
- `POST /process-referral` — traite un code de parrainage (5 parrainages = 1 mois Premium)
  - Headers: `Authorization: Bearer <Firebase ID token>`
  - Body: `{ referralCode }`
