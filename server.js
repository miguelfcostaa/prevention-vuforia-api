const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));


let serviceAccount;

const renderSecretPath = '/etc/secrets/firebase-key.json';
const localPath = './firebase-key.json';

try {
    if (fs.existsSync(renderSecretPath)) {
        serviceAccount = require(renderSecretPath);
        console.log("A ler chaves do Firebase a partir do Secret File do Render.");
    } else {
        serviceAccount = require(localPath);
        console.log("A ler chaves do Firebase localmente.");
    }

    if (serviceAccount && serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

} catch (error) {
    console.error("ERRO FATAL: Não foi possível ler o ficheiro firebase-key.json.", error);
}

const firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: 'prevention-vuforia-api'
});
const bucket = admin.storage().bucket();
// Explicitly define the database ID created by the user
const db = getFirestore(firebaseApp, 'prevention-game');

const ACCESS_KEY = process.env.VUFORIA_SERVER_ACCESS_KEY;
const SECRET_KEY = process.env.VUFORIA_SERVER_SECRET_KEY;

// Função universal de Assinatura
function buildSignature(method, contentType, body, date, requestPath) {
    const bodyString = body ? JSON.stringify(body) : '';
    const contentMD5 = crypto.createHash('md5').update(bodyString).digest('hex');
    const stringToSign = method + '\n' + contentMD5 + '\n' + contentType + '\n' + date + '\n' + requestPath;
    return crypto.createHmac('sha1', SECRET_KEY).update(stringToSign).digest('base64');
}

app.listen(process.env.PORT || 3000, () => {
    console.log('Servidor a correr na porta 3000 e ligado ao Firebase!');
});


app.get('/gallery', async (req, res) => {
    try {
        const [files] = await bucket.getFiles();

        const marcadores = files.map((file) => {
            const parts = file.name.split('---');
            let idReal = "";
            let nomeReal = "";

            if (parts.length === 2) {
                idReal = parts[0];
                nomeReal = parts[1].replace('.png', '').replace('.jpg', '');

                // Link direto do Firebase para o Unity conseguir ler a imagem na UI
                const urlImagem = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(file.name)}?alt=media`;

                return {
                    id: idReal,
                    nome: nomeReal,
                    urlImagem: urlImagem
                };
            }
            return null;
        }).filter(item => item !== null);

        res.json({ marcadores });
    } catch (error) {
        console.error("Erro a ler a galeria:", error);
        res.status(500).json({ success: false, error: "Erro ao ler as imagens do Firebase." });
    }
});


app.get('/targets/:id', async (req, res) => {
    try {
        const targetId = req.params.id;

        const method = 'GET';
        const contentType = '';
        const requestPath = `/targets/${targetId}`;
        const date = new Date().toUTCString();

        const signature = buildSignature(method, contentType, null, date, requestPath);
        const authHeader = `VWS ${ACCESS_KEY}:${signature}`;

        const response = await axios.get(
            `https://vws.vuforia.com/targets/${targetId}`,
            { headers: { Authorization: authHeader, Date: date } }
        );

        res.json(response.data);
    } catch (error) {
        console.error("Erro a verificar status:", error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});


app.post('/targets', async (req, res) => {
    try {
        const { name, width, imageBase64, metadata } = req.body;

        try {
            const [files] = await bucket.getFiles();
            const ficheiroAntigo = files.find(file => file.name.endsWith(`---${name}.png`));

            if (ficheiroAntigo) {
                const oldTargetId = ficheiroAntigo.name.split('---')[0];
                console.log(`[LIMPEZA] Encontrada imagem antiga para ${name} (ID: ${oldTargetId}). A apagar...`);

                // 1. Apagar do Vuforia
                const delMethod = 'DELETE';
                const delPath = `/targets/${oldTargetId}`;
                const delDate = new Date().toUTCString();
                const delSignature = buildSignature(delMethod, '', null, delDate, delPath);
                const delAuthHeader = `VWS ${ACCESS_KEY}:${delSignature}`;

                await axios.delete(`https://vws.vuforia.com/targets/${oldTargetId}`, {
                    headers: { 'Authorization': delAuthHeader, 'Date': delDate }
                });

                // 2. Apagar o ficheiro do Firebase
                await ficheiroAntigo.delete();
                console.log(`[LIMPEZA] Ficheiro antigo apagado do Firebase com sucesso!`);
            }
        } catch (cleanupError) {
            console.warn("[LIMPEZA] Erro ao tentar remover imagem antiga:", cleanupError.message);
        }

        const body = {
            name,
            width,
            image: imageBase64,
            application_metadata: Buffer.from(JSON.stringify(metadata || {})).toString('base64'),
            active_flag: true
        };

        const method = 'POST';
        const contentType = 'application/json';
        const requestPath = '/targets';
        const date = new Date().toUTCString();

        const signature = buildSignature(method, contentType, body, date, requestPath);
        const authHeader = `VWS ${ACCESS_KEY}:${signature}`;

        const response = await axios.post('https://vws.vuforia.com/targets', body, {
            headers: { 'Authorization': authHeader, 'Date': date, 'Content-Type': contentType }
        });

        // 3. Se gravou no Vuforia com sucesso, guarda a cópia no Firebase
        if (response.data && response.data.target_id && imageBase64) {
            const targetId = response.data.target_id;
            const imageBuffer = Buffer.from(imageBase64, 'base64');
            const fileName = `${targetId}---${name}.png`;

            const file = bucket.file(fileName);
            await file.save(imageBuffer, {
                metadata: { contentType: 'image/png' }
            });

            console.log(`Cópia guardada no Firebase: ${fileName}`);
        }

        res.json(response.data);
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});


app.delete('/targets/:id/:name', async (req, res) => {
    try {
        const targetId = req.params.id;
        const targetName = req.params.name;

        const method = 'DELETE';
        const contentType = '';
        const requestPath = `/targets/${targetId}`;
        const date = new Date().toUTCString();

        const signature = buildSignature(method, contentType, null, date, requestPath);
        const authHeader = `VWS ${ACCESS_KEY}:${signature}`;

        const response = await axios.delete(`https://vws.vuforia.com/targets/${targetId}`, {
            headers: { 'Authorization': authHeader, 'Date': date }
        });

        if (response.status === 200 || response.status === 201) {
            const fileName = `${targetId}---${targetName}.png`;
            const file = bucket.file(fileName);

            try {
                await file.delete();
                console.log(`Imagem apagada do Firebase: ${fileName}`);
            } catch (e) {
                console.log(`A imagem ${fileName} já não existia no Firebase.`);
            }
        }

        res.json(response.data);
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});

// --- LEADERBOARD ENDPOINTS ---

// 1. Gravar nova pontuação
app.post('/leaderboard', async (req, res) => {
    try {
        const { username, score } = req.body;

        if (!username || score === undefined) {
            return res.status(400).json({ success: false, error: "Dados incompletos (username ou score)." });
        }

        const docRef = await db.collection('leaderboard').add({
            username: username,
            score: parseInt(score),
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, id: docRef.id });
    } catch (error) {
        console.error("Erro ao gravar na leaderboard:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 2. Obter leaderboard
app.get('/leaderboard', async (req, res) => {
    try {
        const snapshot = await db.collection('leaderboard')
            .orderBy('score', 'desc')
            .get();

        const leaderboard = [];
        snapshot.forEach(doc => {
            leaderboard.push({ id: doc.id, ...doc.data() });
        });

        res.json({ success: true, leaderboard });
    } catch (error) {
        console.error("Erro ao obter leaderboard:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- METRICAS ENDPOINTS ---

// POST /metricas - Save session metrics to Firestore
app.post('/metricas', async (req, res) => {
    try {
        const body = req.body;

        // Validate required fields
        if (!body.sessao_id || !body.username) {
            return res.status(400).json({
                success: false,
                error: 'Os campos "sessao_id" e "username" são obrigatórios.'
            });
        }

        const { sessao_id, ...rest } = body;

        const docData = {
            ...rest,
            sessao_id,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        };

        await db.collection('metricas').doc(sessao_id).set(docData, { merge: true });

        return res.status(200).json({ success: true, id: sessao_id });
    } catch (error) {
        console.error('Erro ao guardar métricas:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});