const express = require('express');
const cors = require('cors');
const path = require('path');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// Initialize Firebase Admin
let db;
if (process.env.FIREBASE_PROJECT_ID) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET
    });
    db = admin.firestore();
    console.log('Firebase Admin and Firestore initialized');
} else {
    console.warn('WARNING: Firebase credentials not set in .env. Authentication will be bypassed and data will NOT be saved permanently!');
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static(path.join(__dirname, '../public')));

// (MongoDB logic removed for Firestore migration)

// ================= SCHEMAS (Removed) =================

// ================= MIDDLEWARE =================

const authenticate = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.split('Bearer ')[1];
    
    // 1. Try Firebase Auth first
    if (process.env.FIREBASE_PROJECT_ID) {
        try {
            const decodedToken = await admin.auth().verifyIdToken(token);
            req.user = decodedToken;
            return next();
        } catch (error) {
            // If Firebase fails, we fall through to try JWT
        }
    }

    // 2. Try JWT for Local Admin
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'nexvora_fallback_secret');
        req.user = decoded;
        next();
    } catch (error) {
        console.error('Authentication Error:', error.message);
        res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
};

// ================= API ROUTES =================

app.get('/api/config', (req, res) => {
    res.json({
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId: process.env.FIREBASE_PROJECT_ID,
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
        appId: process.env.FIREBASE_APP_ID
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USER || 'Chandra';
    const adminPass = process.env.ADMIN_PASS || '123456789';

    if (username === adminUser && password === adminPass) {
        const user = { email: adminUser, uid: 'admin-' + adminUser.toLowerCase(), isLocal: true };
        const token = jwt.sign(user, process.env.JWT_SECRET || 'nexvora_fallback_secret', { expiresIn: '7d' });
        return res.json({ success: true, user, token });
    }
    
    res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/health', (req, res) => {
    res.json({ 
        dbConnected: !!db, 
        message: db ? 'Cloud Database Connected' : 'DATABASE NOT CONFIGURED ON SERVER' 
    });
});

// ----- Invoices -----
app.get('/api/invoices', authenticate, async (req, res) => {
    if(!db) return res.status(503).json({ error: 'Database not configured on server. Check Render environment variables.' });
    try {
        const snapshot = await db.collection('invoices')
            .where('userId', '==', req.user.uid)
            .get();
        const invoices = snapshot.docs.map(doc => ({ ...doc.data(), _id: doc.id }));
        res.json(invoices);
    } catch (e) {
        console.error("Firestore GET error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/invoices', authenticate, async (req, res) => {
    if(!db) return res.status(503).json({ error: 'Database not configured on server. Data was NOT saved to cloud.' });
    const invoice = { ...req.body, userId: req.user.uid, updatedAt: new Date(), createdAt: new Date() };
    
    try {
        const docRef = db.collection('invoices').doc(String(invoice.id));
        await docRef.set(invoice, { merge: true });
        res.json({ success: true, invoice });
    } catch (e) {
        console.error("Firestore POST error:", e);
        res.status(500).json({ error: e.message });
    }
});

// ----- Clients -----
app.get('/api/clients', authenticate, async (req, res) => {
    if(!db) return res.status(503).json({ error: 'Database not configured on server.' });
    try {
        const snapshot = await db.collection('clients')
            .where('userId', '==', req.user.uid)
            .get();
        const clients = snapshot.docs.map(doc => ({ ...doc.data(), _id: doc.id }));
        res.json(clients);
    } catch (e) {
        console.error("Firestore GET error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/clients', authenticate, async (req, res) => {
    if(!db) return res.status(503).json({ error: 'Database not configured on server. Data was NOT saved to cloud.' });
    const client = { ...req.body, userId: req.user.uid, updatedAt: new Date(), createdAt: new Date() };
    try {
        const docRef = db.collection('clients').doc(String(client.id));
        await docRef.set(client, { merge: true });
        res.json({ success: true, client });
    } catch (e) {
        console.error("Firestore POST error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/test-db', authenticate, async (req, res) => {
    if(!db) return res.status(503).json({ error: 'Database not initialized' });
    try {
        const testRef = db.collection('_health_test').doc(req.user.uid);
        await testRef.set({ lastPulse: new Date(), version: '2.0.1' });
        const doc = await testRef.get();
        res.json({ success: true, data: doc.data() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ----- Settings -----
app.get('/api/settings', authenticate, async (req, res) => {
    if(!db) return res.status(503).json({ error: 'Database not configured on server.' });
    try {
        const doc = await db.collection('settings').doc(req.user.uid).get();
        res.json(doc.exists ? doc.data() : {});
    } catch (e) {
        console.error("Firestore GET error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/settings', authenticate, async (req, res) => {
    if(!db) return res.status(503).json({ error: 'Database not configured on server. Settings NOT saved to cloud.' });
    try {
        const settings = { ...req.body, userId: req.user.uid, updatedAt: new Date() };
        await db.collection('settings').doc(req.user.uid).set(settings, { merge: true });
        res.json({ success: true, settings });
    } catch (e) {
        console.error("Firestore PUT error:", e);
        res.status(500).json({ error: e.message });
    }
});

const nodemailer = require('nodemailer');

app.post('/api/verify-smtp', async (req, res) => {
    if(!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        return res.status(400).json({ error: 'SMTP credentials missing in Render environment variables.' });
    }

    try {
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: process.env.SMTP_PORT || 587,
            secure: process.env.SMTP_PORT == 465,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        await transporter.verify();
        res.json({ success: true, message: 'SMTP Connection Successful' });
    } catch (error) {
        console.error("SMTP Verify error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/send-email', async (req, res) => {
    const { to, subject, text, pdfBase64, filename } = req.body;
    
    if(!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        return res.status(500).json({ error: 'SMTP credentials not configured on the server. Please add SMTP_USER and SMTP_PASS to .env' });
    }

    try {
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: process.env.SMTP_PORT || 587,
            secure: process.env.SMTP_PORT == 465,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        const mailOptions = {
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to,
            subject,
            text,
            attachments: [
                {
                    filename: filename || 'invoice.pdf',
                    content: pdfBase64.split('base64,')[1] || pdfBase64,
                    encoding: 'base64'
                }
            ]
        };

        const info = await transporter.sendMail(mailOptions);
        res.json({ success: true, messageId: info.messageId });
    } catch (error) {
        console.error("Email sending error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Danger: Wipe All Data (For fresh start)
app.delete('/api/danger-wipe', async (req, res) => {
    const { password } = req.body;
    if (password !== process.env.ADMIN_PASS) {
        return res.status(403).json({ error: "Unauthorized: Incorrect admin password." });
    }

    if (!db) {
        return res.status(503).json({ error: "Database not connected. Cannot wipe cloud data." });
    }

    try {
        const collections = ['invoices', 'clients', 'settings'];
        for (const coll of collections) {
            const snapshot = await db.collection(coll).get();
            const batch = db.batch();
            snapshot.docs.forEach(doc => {
                batch.delete(doc.ref);
            });
            await batch.commit();
        }
        res.json({ success: true, message: "System reset successful. All data cleared." });
    } catch (err) {
        console.error("Wipe error:", err);
        res.status(500).json({ error: "Failed to wipe database." });
    }
});

// Start the server
// ----- Automation: Recurring Invoices -----
app.post('/api/automation/monthly-invoices', authenticate, async (req, res) => {
    if(!db) return res.status(503).json({ error: 'Database not configured.' });
    
    try {
        const today = new Date();
        const monthYear = `${today.getMonth() + 1}-${today.getFullYear()}`;
        
        // Check if we already ran for this month
        const auditRef = db.collection('automation_audit').doc(monthYear);
        const auditDoc = await auditRef.get();
        if(auditDoc.exists && auditDoc.data().processed) {
            return res.json({ success: true, message: 'Monthly invoices already generated for this period.', count: 0 });
        }

        // Get recurring clients
        const snapshot = await db.collection('clients')
            .where('userId', '==', req.user.uid)
            .where('isRecurring', '==', true)
            .get();
        
        const recurringClients = snapshot.docs.map(doc => doc.data());
        let count = 0;

        for (const client of recurringClients) {
            const invoiceId = `AUTO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            const invoice = {
                id: invoiceId,
                invoiceNo: `INV-AUTO-${Math.floor(1000 + Math.random() * 9000)}`,
                invoiceDate: today.toISOString().split('T')[0],
                dueDate: new Date(today.setDate(today.getDate() + 7)).toISOString().split('T')[0],
                status: 'Sent',
                clientName: client.name,
                clientEmail: client.email || '',
                businessName: client.business || '',
                userId: req.user.uid,
                services: [{ desc: 'Monthly Subscription/Maintenance', qty: 1, rate: client.recurringAmount || 0, amount: client.recurringAmount || 0 }],
                subtotal: client.recurringAmount || 0,
                total: client.recurringAmount || 0,
                balanceDue: client.recurringAmount || 0,
                createdAt: new Date()
            };
            await db.collection('invoices').doc(invoiceId).set(invoice);
            count++;
        }

        await auditRef.set({ processed: true, count, processedAt: new Date() });
        res.json({ success: true, message: `Successfully automated ${count} invoices.`, count });
    } catch (e) {
        console.error("Automation Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
