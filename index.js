const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');       // NOVO: Para gravar ficheiros no servidor
const path = require('path');   // NOVO: Para lidar com caminhos de pastas
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// NOVO: Diz ao Express para tornar a pasta 'uploads' pública para o Unity aceder
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const ACCESS_KEY = process.env.VUFORIA_SERVER_ACCESS_KEY;
const SECRET_KEY = process.env.VUFORIA_SERVER_SECRET_KEY;

// Função auxiliar para ler/escrever no nosso db.json local
const dbPath = path.join(__dirname, 'db.json');
function getLocalDB() {
    if (fs.existsSync(dbPath)) return JSON.parse(fs.readFileSync(dbPath));
    return [];
}
function saveLocalDB(data) {
    fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

function buildSignature(method, contentType, body, date, requestPath) {
    const bodyString = body ? JSON.stringify(body) : '';

    const contentMD5 = crypto
        .createHash('md5')
        .update(bodyString)
        .digest('hex');

    const stringToSign =
        method + '\n' +
        contentMD5 + '\n' +
        contentType + '\n' +
        date + '\n' +
        requestPath;

    const signature = crypto
        .createHmac('sha1', SECRET_KEY)
        .update(stringToSign)
        .digest('base64');

    return signature;
}

// ----------------------------------------------------
// NOVO ENDPOINT: O UNITY VAI CHAMAR ISTO PARA A GALERIA
// ----------------------------------------------------
app.get('/marcadores', (req, res) => {
    try {
        const db = getLocalDB();
        res.json({ marcadores: db });
    } catch (error) {
        res.status(500).json({ success: false, error: "Erro ao ler a base de dados local." });
    }
});


app.post('/targets', async (req, res) => {
    try {
        const { name, width, imageBase64, metadata } = req.body;

        const body = {
            name,
            width,
            image: imageBase64,
            application_metadata: Buffer.from(
                JSON.stringify(metadata || {})
            ).toString('base64'),
            active_flag: true
        };

        const method = 'POST';
        const contentType = 'application/json';
        const requestPath = '/targets';
        const date = new Date().toUTCString();
        const signature = buildSignature(method, contentType, body, date, requestPath);
        const authHeader = `VWS ${ACCESS_KEY}:${signature}`;

        // 1. Envia para o Vuforia
        const response = await axios.post(
            'https://vws.vuforia.com/targets',
            body,
            {
                headers: {
                    'Authorization': authHeader,
                    'Date': date,
                    'Content-Type': contentType
                }
            }
        );

        // 2. Vuforia Aceitou! Agora vamos guardar localmente para o Unity conseguir ver
        const vuforiaId = response.data.target_id;
        
        // Cria a pasta uploads se não existir
        const dir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);

        // Converte o base64 de volta para imagem e guarda
        const imageBuffer = Buffer.from(imageBase64, 'base64');
        const imageFileName = `${vuforiaId}.png`;
        fs.writeFileSync(path.join(dir, imageFileName), imageBuffer);

        // Atualiza a base de dados local
        const db = getLocalDB();
        db.push({
            id: vuforiaId,
            nome: name,
            // IMPORTANTE: Em produção, deves mudar o localhost para o teu IP ou Domínio!
            urlImagem: `http://localhost:3000/uploads/${imageFileName}` 
        });
        saveLocalDB(db);

        res.json(response.data);
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});

// A tua rota GET /targets original (que vai buscar ao Vuforia) mantém-se igual
app.get('/targets', async (req, res) => {
    try {
        const method = 'GET';
        const contentType = '';
        const requestPath = '/targets';
        const date = new Date().toUTCString();
        const contentMD5 = 'd41d8cd98f00b204e9800998ecf8427e';

        const stringToSign = method + '\n' + contentMD5 + '\n' + contentType + '\n' + date + '\n' + requestPath;
        const signature = crypto.createHmac('sha1', SECRET_KEY).update(stringToSign).digest('base64');
        const authHeader = `VWS ${ACCESS_KEY}:${signature}`;

        const response = await axios.get('https://vws.vuforia.com/targets', {
            headers: { Authorization: authHeader, Date: date }
        });

        res.json(response.data);
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});

app.delete('/targets/:id', async (req, res) => {
    try {
        const targetId = req.params.id;
        const method = 'DELETE';
        const contentType = '';
        const requestPath = `/targets/${targetId}`;
        const date = new Date().toUTCString();

        const stringToSign = method + '\n' + '\n' + contentType + '\n' + date + '\n' + requestPath;
        const signature = crypto.createHmac('sha1', SECRET_KEY).update(stringToSign).digest('base64');
        const authHeader = `VWS ${ACCESS_KEY}:${signature}`;

        // 1. Apaga do Vuforia
        const response = await axios.delete(`https://vws.vuforia.com/targets/${targetId}`, {
            headers: { 'Authorization': authHeader, 'Date': date }
        });

        // 2. Apaga da nossa base de dados local e o ficheiro da imagem
        const db = getLocalDB();
        const index = db.findIndex(m => m.id === targetId);
        if (index !== -1) {
            const imagePath = path.join(__dirname, 'uploads', `${targetId}.png`);
            if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath); // Apaga a imagem
            db.splice(index, 1); // Apaga do JSON
            saveLocalDB(db);
        }

        res.json(response.data);
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log('Servidor a correr na porta 3000');
});