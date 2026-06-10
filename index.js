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
const PLAN_PRICES = { premium: 4900, business: 14900 };
const AFFILIATE_RATE = 0.05;

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Shoply Notifications' });
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
    subtotal, deliveryFee, fedapayFee, total, transactionId, affiliateUid,
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

    await orderRef.set(orderData);

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

// POST /notify-new-product
// Body: { shopId, shopName, productName, productId }
app.post('/notify-new-product', async (req, res) => {
  const { shopId, shopName, productName, productId } = req.body;
  if (!shopId || !productName) return res.status(400).json({ error: 'shopId and productName required' });

  try {
    // Get all subscribers for this shop
    const snap = await db.collection('subscriptions')
      .where('shopId', '==', shopId)
      .get();

    if (snap.empty) return res.json({ sent: 0 });

    const tokens = snap.docs.map(d => d.data().fcmToken).filter(Boolean);
    if (!tokens.length) return res.json({ sent: 0 });

    // Send FCM multicast (max 500 per call)
    const chunks = [];
    for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));

    let sent = 0;
    for (const chunk of chunks) {
      const response = await messaging.sendEachForMulticast({
        tokens: chunk,
        notification: {
          title: `🛍️ Nouveau produit chez ${shopName}`,
          body: productName,
        },
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

    res.json({ sent, total: tokens.length });
  } catch (err) {
    console.error('Notification error:', err);
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Shoply Notifications running on port ${PORT}`));
