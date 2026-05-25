const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');      // NOVO: Para gravar ficheiros no servidor
const path = require('path');  // NOVO: Para gerir caminhos de pastas
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// NOVO: Criar pasta 'uploads' se não existir ao ligar o servidor
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// NOVO: Dizer ao Express para expor a pasta 'uploads' publicamente para o Unity conseguir ler os URLs
app.use('/uploads', express.static(uploadsDir));

const ACCESS_KEY = process.env.VUFORIA_SERVER_ACCESS_KEY;
const SECRET_KEY = process.env.VUFORIA_SERVER_SECRET_KEY;

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

// Iniciar o servidor
app.listen(process.env.PORT || 3000, () => {
    console.log('Servidor a correr na porta 3000');
});

// ==============================================================
// ROTA NOVA: DEVOLVE A LISTA DE IMAGENS PARA A GALERIA DO UNITY
// ==============================================================
app.get('/gallery', (req, res) => {
    try {
        // Lê todos os ficheiros que estão na pasta 'uploads'
        const files = fs.readdirSync(uploadsDir);
        
        // Pega no URL base do servidor (ex: http://localhost:3000 ou o teu domínio online)
        const baseUrl = `${req.protocol}://${req.get('host')}/uploads/`;

        // Constrói o JSON exatamente no formato que o nosso script do Unity espera
        const marcadores = files.map((file, index) => {
            return {
                id: index.toString(),
                nome: path.parse(file).name, // Tira a extensão .png/.jpg do nome
                urlImagem: baseUrl + file
            };
        });

        res.json({ marcadores });
    } catch (error) {
        console.error("Erro a ler a galeria:", error);
        res.status(500).json({ success: false, error: "Erro ao ler as imagens locais." });
    }
});


// ==============================================================
// ROTAS DO VUFORIA
// ==============================================================

app.post('/targets', async (req, res) => {
    try {
        const { name, width, imageBase64, metadata } = req.body;

        // NOVO: Antes de enviar para o Vuforia, guarda uma cópia física no servidor!
        if (imageBase64) {
            const imageBuffer = Buffer.from(imageBase64, 'base64');
            const imagePath = path.join(uploadsDir, `${name}.png`);
            fs.writeFileSync(imagePath, imageBuffer);
            console.log(`Cópia local guardada: ${imagePath}`);
        }

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

        res.json(response.data);
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});

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

app.get('/targets/:id', async (req, res) => {
    try {
        const targetId = req.params.id;
        const method = 'GET';
        const contentType = '';
        const requestPath = `/targets/${targetId}`;
        const date = new Date().toUTCString();
        const contentMD5 = 'd41d8cd98f00b204e9800998ecf8427e';

        const stringToSign = method + '\n' + contentMD5 + '\n' + contentType + '\n' + date + '\n' + requestPath;
        const signature = crypto.createHmac('sha1', SECRET_KEY).update(stringToSign).digest('base64');
        const authHeader = `VWS ${ACCESS_KEY}:${signature}`;

        const response = await axios.get(`https://vws.vuforia.com/targets/${targetId}`, {
            headers: { Authorization: authHeader, Date: date }
        });

        res.json(response.data);
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});

app.delete('/targets/:id/:name', async (req, res) => {
    try {
        const targetId = req.params.id;
        const targetName = req.params.name; // Útil para apagar a imagem local

        const method = 'DELETE';
        const contentType = '';
        const requestPath = `/targets/${targetId}`;
        const date = new Date().toUTCString();

        const stringToSign = method + '\n\n' + contentType + '\n' + date + '\n' + requestPath;
        const signature = crypto.createHmac('sha1', SECRET_KEY).update(stringToSign).digest('base64');
        const authHeader = `VWS ${ACCESS_KEY}:${signature}`;

        const response = await axios.delete(`https://vws.vuforia.com/targets/${targetId}`, {
            headers: { 'Authorization': authHeader, 'Date': date }
        });

        // NOVO: Se o Vuforia apagou com sucesso, apaga também a imagem do teu servidor
        if (response.status === 200) {
            const imagePath = path.join(uploadsDir, `${targetName}.png`);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
                console.log(`Imagem apagada do servidor: ${imagePath}`);
            }
        }

        res.json(response.data);
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});