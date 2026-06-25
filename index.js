const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Firebase Admin init via environment variable (JSON string)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY;
const FEDAPAY_API_BASE = 'https://api.fedapay.com/v1';
const PLAN_PRICES = { premium: 900, business: 4900 };
const AFFILIATE_RATE = 0.05;
const SITE_BASE_URL = 'https://myshoply.web.app';

// Reproduit lib/slug.ts (frontend) pour générer les mêmes URLs /product/[slug]/
function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function getProductSlug(product) {
  return `${slugify(product.name)}-${product.id}`;
}

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Shoply Notifications' });
});

// GET /catalog/:shopId.csv
// Flux catalogue produits au format CSV, compatible avec Facebook/Instagram
// Commerce Manager et TikTok Catalog Manager. URL publique, à soumettre par
// le vendeur dans son gestionnaire de catalogue (rafraîchissement automatique
// périodique par la plateforme — toujours à jour car généré en direct depuis
// Firestore à chaque requête, pas un export statique figé).
app.get('/catalog/:shopId.csv', async (req, res) => {
  const { shopId } = req.params;

  try {
    const shopSnap = await db.collection('shops').doc(shopId).get();
    if (!shopSnap.exists) return res.status(404).send('Boutique introuvable');
    const shop = shopSnap.data();

    const productsSnap = await db.collection('products')
      .where('shopId', '==', shopId)
      .where('isActive', '==', true)
      .get();

    const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;

    const header = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'brand'];
    const rows = productsSnap.docs.map((doc) => {
      const p = doc.data();
      const link = `${SITE_BASE_URL}/product/${getProductSlug(p)}/`;
      return [
        p.id,
        p.name,
        p.description || p.name,
        p.stock > 0 ? 'in stock' : 'out of stock',
        'new',
        `${Math.round(p.price)} XOF`,
        link,
        p.images?.[0] || '',
        shop.name,
      ].map(escapeCsv).join(',');
    });

    const csv = [header.join(','), ...rows].join('\n');

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=1800');
    res.send(csv);
  } catch (err) {
    console.error('Catalog feed error:', err);
    res.status(500).send('Erreur lors de la génération du catalogue');
  }
});

// Verify Firebase ID token sent as "Authorization: Bearer <token>"
async function verifyIdToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    return await admin.auth().verifyIdToken(token);
  } catch {
    return null;
  }
}

// POST /activate-plan
// Body: { shopId, plan, transactionId }
// Verifies the FedaPay transaction server-side before granting a paid plan.
app.post('/activate-plan', async (req, res) => {
  const decoded = await verifyIdToken(req);
  if (!decoded) return res.status(401).json({ error: 'Non authentifié' });

  const { shopId, plan, transactionId } = req.body;
  if (!shopId || !transactionId || !PLAN_PRICES[plan]) {
    return res.status(400).json({ error: 'Paramètres invalides' });
  }

  try {
    const shopRef = db.collection('shops').doc(shopId);
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'Boutique introuvable' });
    const shop = shopSnap.data();
    if (shop.ownerId !== decoded.uid) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    // Prevent replaying the same FedaPay transaction
    const existing = await db.collection('payments')
      .where('transactionRef', '==', String(transactionId))
      .limit(1).get();
    if (!existing.empty) {
      return res.status(409).json({ error: 'Transaction déjà utilisée' });
    }

    // Verify the transaction directly with FedaPay
    const fpRes = await fetch(`${FEDAPAY_API_BASE}/transactions/${transactionId}`, {
      headers: { Authorization: `Bearer ${FEDAPAY_SECRET_KEY}` },
    });
    if (!fpRes.ok) return res.status(400).json({ error: 'Transaction FedaPay introuvable' });
    const fpData = await fpRes.json();
    const tx = fpData['v1/transaction'] || fpData.transaction || fpData;

    if (tx.status !== 'approved') {
      return res.status(400).json({ error: 'Paiement non confirmé' });
    }
    if (Number(tx.amount) !== PLAN_PRICES[plan]) {
      return res.status(400).json({ error: 'Montant incorrect' });
    }
    if (tx.currency?.iso && tx.currency.iso !== 'XOF') {
      return res.status(400).json({ error: 'Devise incorrecte' });
    }

    await shopRef.update({ plan, updatedAt: new Date().toISOString() });
    await db.collection('payments').add({
      shopId,
      ownerEmail: shop.ownerEmail || '',
      plan,
      amount: PLAN_PRICES[plan],
      currency: 'XOF',
      transactionRef: String(transactionId),
      createdAt: new Date().toISOString(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error('activate-plan error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /process-referral
// Body: { referralCode }
// Replays the referral logic server-side (Admin SDK), so it can update
// the referrer's shop document regardless of who triggers it.
app.post('/process-referral', async (req, res) => {
  const decoded = await verifyIdToken(req);
  if (!decoded) return res.status(401).json({ error: 'Non authentifié' });

  const { referralCode } = req.body;
  if (!referralCode) return res.status(400).json({ error: 'Code requis' });

  try {
    const code = String(referralCode).toUpperCase();
    const referrerSnap = await db.collection('shops').where('referralCode', '==', code).limit(1).get();
    if (referrerSnap.empty) return res.json({ success: false, reason: 'not_found' });
    const referrerDoc = referrerSnap.docs[0];
    const referrer = referrerDoc.data();

    if (referrer.ownerId === decoded.uid) {
      return res.json({ success: false, reason: 'self_referral' });
    }

    const dupSnap = await db.collection('referrals')
      .where('referredUid', '==', decoded.uid)
      .where('referralCode', '==', code)
      .limit(1).get();
    if (!dupSnap.empty) {
      return res.json({ success: false, reason: 'already_used' });
    }

    await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(referrerDoc.ref);
      const fresh = freshSnap.data();
      const newCount = (fresh.referralCount || 0) + 1;

      const refRef = db.collection('referrals').doc();
      tx.set(refRef, {
        id: refRef.id,
        referralCode: code,
        referrerShopId: referrerDoc.id,
        referrerOwnerId: referrer.ownerId,
        referredUid: decoded.uid,
        referredEmail: decoded.email || '',
        createdAt: new Date().toISOString(),
      });

      if (newCount >= 5) {
        const premiumUntil = new Date();
        premiumUntil.setMonth(premiumUntil.getMonth() + 1);
        tx.update(referrerDoc.ref, {
          referralCount: 0,
          plan: 'premium',
          premiumUntil: premiumUntil.toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } else {
        tx.update(referrerDoc.ref, {
          referralCount: newCount,
          updatedAt: new Date().toISOString(),
        });
      }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('process-referral error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /add-staff
// Body: { shopId, staffEmail } — Auth: Bearer <ownerIdToken>
// Donne accès au dashboard de la boutique à un compte Shoply existant
// (recherché par email via Admin SDK). Réservé au propriétaire. La personne
// ajoutée doit déjà avoir un compte Shoply — pas d'envoi d'email d'invitation.
app.post('/add-staff', async (req, res) => {
  const decoded = await verifyIdToken(req);
  if (!decoded) return res.status(401).json({ error: 'Non authentifié' });

  const { shopId, staffEmail } = req.body;
  if (!shopId || !staffEmail) return res.status(400).json({ error: 'Paramètres invalides' });

  try {
    const shopRef = db.collection('shops').doc(shopId);
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'Boutique introuvable' });
    const shop = shopSnap.data();
    if (shop.ownerId !== decoded.uid) {
      return res.status(403).json({ error: 'Seul le propriétaire peut ajouter un employé' });
    }

    const currentStaff = shop.staffUids || [];
    if (currentStaff.length >= 15) {
      return res.status(400).json({ error: 'Limite de 15 employés atteinte' });
    }

    let staffUser;
    try {
      staffUser = await admin.auth().getUserByEmail(String(staffEmail).trim());
    } catch {
      return res.status(404).json({ error: 'Aucun compte Shoply trouvé avec cet email. La personne doit déjà avoir un compte.' });
    }

    if (staffUser.uid === shop.ownerId) {
      return res.status(400).json({ error: 'C\'est déjà le propriétaire de la boutique' });
    }
    if (currentStaff.includes(staffUser.uid)) {
      return res.status(409).json({ error: 'Cette personne a déjà accès à la boutique' });
    }

    await shopRef.update({
      staffUids: admin.firestore.FieldValue.arrayUnion(staffUser.uid),
      [`staffEmails.${staffUser.uid}`]: staffUser.email,
      updatedAt: new Date().toISOString(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error('add-staff error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /remove-staff
// Body: { shopId, staffUid } — Auth: Bearer <ownerIdToken>
app.post('/remove-staff', async (req, res) => {
  const decoded = await verifyIdToken(req);
  if (!decoded) return res.status(401).json({ error: 'Non authentifié' });

  const { shopId, staffUid } = req.body;
  if (!shopId || !staffUid) return res.status(400).json({ error: 'Paramètres invalides' });

  try {
    const shopRef = db.collection('shops').doc(shopId);
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'Boutique introuvable' });
    const shop = shopSnap.data();
    if (shop.ownerId !== decoded.uid) {
      return res.status(403).json({ error: 'Seul le propriétaire peut retirer un employé' });
    }

    await shopRef.update({
      staffUids: admin.firestore.FieldValue.arrayRemove(staffUid),
      [`staffEmails.${staffUid}`]: admin.firestore.FieldValue.delete(),
      updatedAt: new Date().toISOString(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error('remove-staff error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /create-paid-order
// Body: { shopId, items, customerName, customerPhone, customerAddress, customerEmail?,
//         notes?, subtotal, deliveryFee, fedapayFee, total, transactionId,
//         affiliateUid? }
// Plan Gratuit uniquement : le client paie via FedaPay (escrow Shoply). La
// commande n'est créée qu'après vérification de la transaction côté FedaPay,
// ce qui empêche un client de fabriquer une commande "payée" sans payer.
app.post('/create-paid-order', async (req, res) => {
  const {
    shopId, items, customerName, customerPhone, customerAddress, customerEmail, notes,
    subtotal, deliveryFee, deliveryZone, fedapayFee, total, transactionId, affiliateUid,
  } = req.body;

  if (!shopId || !Array.isArray(items) || !items.length || !transactionId
    || !customerName || !customerPhone
    || typeof subtotal !== 'number' || typeof fedapayFee !== 'number' || typeof total !== 'number') {
    return res.status(400).json({ error: 'Paramètres invalides' });
  }

  try {
    const shopRef = db.collection('shops').doc(shopId);
    const shopSnap = await shopRef.get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'Boutique introuvable' });
    const shop = shopSnap.data();
    if (shop.plan !== 'free') {
      return res.status(400).json({ error: 'Le paiement FedaPay à la commande est réservé au plan Gratuit' });
    }

    // Empêche de réutiliser la même transaction FedaPay pour plusieurs commandes
    const existing = await db.collection('orders')
      .where('fedapayTransactionId', '==', String(transactionId))
      .limit(1).get();
    if (!existing.empty) {
      return res.status(409).json({ error: 'Transaction déjà utilisée' });
    }

    // Vérifie la transaction directement auprès de FedaPay
    const fpRes = await fetch(`${FEDAPAY_API_BASE}/transactions/${transactionId}`, {
      headers: { Authorization: `Bearer ${FEDAPAY_SECRET_KEY}` },
    });
    if (!fpRes.ok) return res.status(400).json({ error: 'Transaction FedaPay introuvable' });
    const fpData = await fpRes.json();
    const tx = fpData['v1/transaction'] || fpData.transaction || fpData;

    if (tx.status !== 'approved') {
      return res.status(400).json({ error: 'Paiement non confirmé' });
    }
    if (Number(tx.amount) !== Math.round(total)) {
      return res.status(400).json({ error: 'Montant incorrect' });
    }
    if (tx.currency?.iso && tx.currency.iso !== 'XOF') {
      return res.status(400).json({ error: 'Devise incorrecte' });
    }

    const vendorPayoutAmount = Math.round(subtotal + (deliveryFee || 0));
    const now = new Date().toISOString();

    const orderRef = db.collection('orders').doc();
    const orderData = {
      id: orderRef.id,
      shopId,
      customerName,
      customerPhone,
      customerAddress: customerAddress || '',
      customerEmail: customerEmail || '',
      items,
      subtotal,
      deliveryFee: deliveryFee || 0,
      deliveryZone: deliveryZone || null,
      total,
      currency: 'XOF',
      paymentMethod: 'fedapay',
      paymentStatus: 'paid',
      paymentReceived: true,
      paymentReceivedAt: now,
      status: 'pending',
      notes: notes || '',
      fedapayTransactionId: String(transactionId),
      fedapayFee,
      vendorPayoutAmount,
      vendorPayoutPaid: false,
      deliveryStatus: 'awaiting_assignment',
      createdAt: now,
      updatedAt: now,
    };

    // Commission affilié recalculée côté serveur (anti-fraude)
    if (affiliateUid && affiliateUid !== shop.ownerId) {
      orderData.affiliateUid = affiliateUid;
      orderData.affiliateCommission = Math.round(vendorPayoutAmount * AFFILIATE_RATE);
    }

    // Assigne automatiquement le service de livraison Shoply (livreur actif)
    // et lui envoie une notification automatique avec les infos de livraison.
    const agentsSnap = await db.collection('deliveryAgents').where('active', '==', true).get();
    const activeAgents = agentsSnap.docs.map(d => d.data())
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    const agent = activeAgents[0];

    if (agent) {
      orderData.deliveryAgentId = agent.email;
      orderData.deliveryAgentName = agent.name;
      orderData.deliveryStatus = 'assigned';
    }

    // Décrémente le stock de chaque produit en même temps que la création de
    // la commande (transaction), pour rester cohérent avec le flux client
    // (lib/firestore.ts createOrder) — le stock ne descend jamais sous 0.
    // Au passage, repère les produits qui viennent de passer sous le seuil
    // d'alerte (≤ 3) pour notifier le vendeur juste après.
    const lowStockAlerts = [];
    await db.runTransaction(async (tx) => {
      const productRefs = items.map(it => db.collection('products').doc(it.productId));
      const productSnaps = await Promise.all(productRefs.map(r => tx.get(r)));
      productSnaps.forEach((snap, i) => {
        if (!snap.exists) return;
        const currentStock = snap.data().stock ?? 0;
        const nextStock = Math.max(0, currentStock - items[i].quantity);
        tx.update(productRefs[i], { stock: nextStock, updatedAt: now });
        if (currentStock > 3 && nextStock <= 3) {
          lowStockAlerts.push({ productName: items[i].productName, stock: nextStock });
        }
      });
      tx.set(orderRef, orderData);
    });

    if (shop.ownerFcmToken && lowStockAlerts.length > 0) {
      for (const alert of lowStockAlerts) {
        try {
          await messaging.send({
            token: shop.ownerFcmToken,
            notification: {
              title: `⚠️ Stock bas — ${shop.name}`,
              body: `${alert.productName} : plus que ${alert.stock} en stock.`,
            },
            data: { url: 'https://myshoply.web.app/dashboard/products' },
            webpush: { fcmOptions: { link: 'https://myshoply.web.app/dashboard/products' } },
          });
        } catch (err) {
          console.error('FCM low-stock alert error:', err.message);
        }
      }
    }

    if (agent) {
      if (agent.fcmToken) {
        const itemsSummary = items.map(it => `${it.productName} x${it.quantity}`).join(', ');
        try {
          await messaging.send({
            token: agent.fcmToken,
            notification: {
              title: '🚚 Nouvelle livraison à effectuer',
              body: `${customerName} — ${customerAddress || customerPhone} — ${itemsSummary}`,
            },
            data: {
              orderId: orderRef.id,
              url: 'https://myshoply.web.app/livreur',
            },
            webpush: {
              fcmOptions: { link: 'https://myshoply.web.app/livreur' },
            },
          });
        } catch (err) {
          console.error('FCM notify delivery agent error:', err.message);
        }
      }
    }

    res.json({ success: true, orderId: orderRef.id });
  } catch (err) {
    console.error('create-paid-order error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Envoie une notification push à tous les abonnés d'une boutique.
async function notifyShopSubscribers(shopId, productId, title, body) {
  const snap = await db.collection('subscriptions')
    .where('shopId', '==', shopId)
    .get();

  if (snap.empty) return { sent: 0, total: 0 };

  const tokens = snap.docs.map(d => d.data().fcmToken).filter(Boolean);
  if (!tokens.length) return { sent: 0, total: 0 };

  // Send FCM multicast (max 500 per call)
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));

  let sent = 0;
  for (const chunk of chunks) {
    const response = await messaging.sendEachForMulticast({
      tokens: chunk,
      notification: { title, body },
      data: {
        shopId,
        productId: productId || '',
        url: `https://myshoply.web.app/shop/${shopId}`,
      },
      webpush: {
        fcmOptions: {
          link: `https://myshoply.web.app/shop/${shopId}`,
        },
      },
    });
    sent += response.successCount;

    // Clean up invalid tokens
    response.responses.forEach((r, idx) => {
      if (!r.success && (r.error?.code === 'messaging/invalid-registration-token' || r.error?.code === 'messaging/registration-token-not-registered')) {
        const token = chunk[idx];
        db.collection('subscriptions').where('fcmToken', '==', token).get()
          .then(s => s.docs.forEach(d => d.ref.delete()))
          .catch(() => {});
      }
    });
  }

  return { sent, total: tokens.length };
}

// POST /notify-new-product
// Body: { shopId, shopName, productName, productId }
app.post('/notify-new-product', async (req, res) => {
  const { shopId, shopName, productName, productId } = req.body;
  if (!shopId || !productName) return res.status(400).json({ error: 'shopId and productName required' });

  try {
    const result = await notifyShopSubscribers(shopId, productId, `🛍️ Nouveau produit chez ${shopName}`, productName);
    res.json(result);
  } catch (err) {
    console.error('Notification error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /notify-restock
// Body: { shopId, shopName, productName, productId } — un produit
// précédemment épuisé (stock 0) redevient disponible.
app.post('/notify-restock', async (req, res) => {
  const { shopId, shopName, productName, productId } = req.body;
  if (!shopId || !productName) return res.status(400).json({ error: 'shopId and productName required' });

  try {
    const result = await notifyShopSubscribers(shopId, productId, `✅ De retour en stock chez ${shopName}`, productName);
    res.json(result);
  } catch (err) {
    console.error('Notification error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /notify-low-stock
// Body: { shopId, productId?, productName, stock } — un produit vient de
// passer sous le seuil d'alerte (≤ 3 unités) suite à une commande créée
// côté client (lib/firestore.ts createOrder). Notifie le PROPRIÉTAIRE via
// son propre token FCM (Shop.ownerFcmToken) — pas les abonnés clients.
app.post('/notify-low-stock', async (req, res) => {
  const { shopId, productId, productName, stock } = req.body;
  if (!shopId || !productName) return res.status(400).json({ error: 'shopId and productName required' });

  try {
    const shopSnap = await db.collection('shops').doc(shopId).get();
    if (!shopSnap.exists) return res.status(404).json({ error: 'Boutique introuvable' });
    const shop = shopSnap.data();
    if (!shop.ownerFcmToken) return res.json({ success: false, reason: 'no_token' });

    await messaging.send({
      token: shop.ownerFcmToken,
      notification: {
        title: `⚠️ Stock bas — ${shop.name}`,
        body: `${productName} : plus que ${stock} en stock.`,
      },
      data: { productId: productId || '', url: 'https://myshoply.web.app/dashboard/products' },
      webpush: { fcmOptions: { link: 'https://myshoply.web.app/dashboard/products' } },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('notify-low-stock error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// POST /resend-delivery-notification
// Body: { orderId } — Admin uniquement. Renvoie une notification push au
// livreur assigné pour le relancer sur une livraison en cours.
app.post('/resend-delivery-notification', async (req, res) => {
  const decoded = await verifyIdToken(req);
  if (!decoded || decoded.email !== 'didilolade@gmail.com') {
    return res.status(403).json({ error: 'Non autorisé' });
  }

  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId requis' });

  try {
    const orderSnap = await db.collection('orders').doc(orderId).get();
    if (!orderSnap.exists) return res.status(404).json({ error: 'Commande introuvable' });
    const order = orderSnap.data();

    if (!order.deliveryAgentId) return res.status(400).json({ error: 'Aucun livreur assigné à cette commande' });

    const agentSnap = await db.collection('deliveryAgents').doc(order.deliveryAgentId).get();
    if (!agentSnap.exists || !agentSnap.data().fcmToken) {
      return res.status(400).json({ error: 'Le livreur n\'a pas activé les notifications' });
    }

    const agent = agentSnap.data();
    const itemsSummary = (order.items || []).map(it => `${it.productName} x${it.quantity}`).join(', ');

    await messaging.send({
      token: agent.fcmToken,
      notification: {
        title: '🔔 Rappel : livraison en attente',
        body: `${order.customerName} — ${order.customerAddress || order.customerPhone} — ${itemsSummary}`,
      },
      data: {
        orderId,
        url: 'https://myshoply.web.app/livreur',
      },
      webpush: {
        fcmOptions: { link: 'https://myshoply.web.app/livreur' },
      },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('resend-delivery-notification error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── API publique en lecture (clé API par boutique) ─────────────────────
// Limite de débit en mémoire, par boutique, selon son plan. Suffisant pour
// une seule instance Render — pas de store partagé (Redis) à ce stade.
const API_RATE_LIMITS = { free: 30, premium: 60, business: 300 }; // requêtes/minute
const apiRateLimitState = new Map(); // shopId -> { count, windowStart }

async function authenticateApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (!apiKey) return res.status(401).json({ error: 'Clé API manquante (en-tête x-api-key)' });

  try {
    const snap = await db.collection('shops').where('apiKey', '==', apiKey).limit(1).get();
    if (snap.empty) return res.status(401).json({ error: 'Clé API invalide' });
    const shop = snap.docs[0].data();
    if (shop.suspended) return res.status(403).json({ error: 'Boutique suspendue' });

    const limit = API_RATE_LIMITS[shop.plan] || API_RATE_LIMITS.free;
    const now = Date.now();
    const state = apiRateLimitState.get(shop.id) || { count: 0, windowStart: now };
    if (now - state.windowStart > 60_000) {
      state.count = 0;
      state.windowStart = now;
    }
    state.count += 1;
    apiRateLimitState.set(shop.id, state);
    res.set('X-RateLimit-Limit', String(limit));
    res.set('X-RateLimit-Remaining', String(Math.max(0, limit - state.count)));
    if (state.count > limit) {
      return res.status(429).json({ error: `Limite de ${limit} requêtes/minute dépassée pour le plan ${shop.plan}` });
    }

    req.apiShop = shop;
    next();
  } catch (err) {
    console.error('API auth error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

// GET /api/v1/products — liste des produits de la boutique propriétaire de la clé
app.get('/api/v1/products', authenticateApiKey, async (req, res) => {
  try {
    const snap = await db.collection('products').where('shopId', '==', req.apiShop.id).get();
    res.json({ data: snap.docs.map((d) => d.data()) });
  } catch (err) {
    console.error('API products error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/v1/orders — liste des commandes de la boutique propriétaire de la clé
app.get('/api/v1/orders', authenticateApiKey, async (req, res) => {
  try {
    const snap = await db.collection('orders').where('shopId', '==', req.apiShop.id).get();
    res.json({ data: snap.docs.map((d) => d.data()) });
  } catch (err) {
    console.error('API orders error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Shoply Notifications running on port ${PORT}`));
