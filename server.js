const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');      
const path = require('path');  
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

app.use('/uploads', express.static(uploadsDir));

const ACCESS_KEY = process.env.VUFORIA_SERVER_ACCESS_KEY;
const SECRET_KEY = process.env.VUFORIA_SERVER_SECRET_KEY;

// Função universal de Assinatura (Agora serve perfeitamente para GET, POST e DELETE)
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

app.listen(process.env.PORT || 3000, () => {
    console.log('Servidor a correr na porta 3000');
});

// ==============================================================
// ROTA DA GALERIA (Atualizada para ler o ID e o Nome do ficheiro)
// ==============================================================
app.get('/gallery', (req, res) => {
    try {
        const files = fs.readdirSync(uploadsDir);
        const baseUrl = `${req.protocol}://${req.get('host')}/uploads/`;

        const marcadores = files.map((file) => {
            // O ficheiro será guardado como: "TARGETID---NOME.png"
            const parts = file.split('---');
            let idReal = "";
            let nomeReal = "";

            if (parts.length === 2) {
                idReal = parts[0];
                nomeReal = parts[1].replace('.png', '').replace('.jpg', '');
            } else {
                // Ignora ficheiros que não estejam no formato novo
                return null;
            }

            return {
                id: idReal,
                nome: nomeReal,
                urlImagem: baseUrl + file
            };
        }).filter(item => item !== null); // Remove ficheiros inválidos

        res.json({ marcadores });
    } catch (error) {
        console.error("Erro a ler a galeria:", error);
        res.status(500).json({ success: false, error: "Erro ao ler as imagens locais." });
    }
});


// ==============================================================
// ROTAS DO VUFORIA
// ==============================================================

app.get('/targets/:id', async (req, res) => {
    try {
        const targetId = req.params.id;

        const method = 'GET';
        const contentType = '';
        const requestPath = `/targets/${targetId}`;
        const date = new Date().toUTCString();

        // Para rotas GET específicas, o contentMD5 pode não ser necessário ou é nulo
        const signature = buildSignature(method, contentType, null, date, requestPath);
        const authHeader = `VWS ${ACCESS_KEY}:${signature}`;

        const response = await axios.get(
            `https://vws.vuforia.com/targets/${targetId}`,
            {
                headers: {
                    Authorization: authHeader,
                    Date: date
                }
            }
        );

        res.json(response.data);
    } catch (error) {
        console.error("Erro a verificar status:", error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data || error.message
        });
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

        // 1. FAZ O UPLOAD PARA O VUFORIA PRIMEIRO
        const response = await axios.post('https://vws.vuforia.com/targets', body, {
            headers: { 'Authorization': authHeader, 'Date': date, 'Content-Type': contentType }
        });

        // 2. SE SUCESSO, GUARDA LOCALMENTE COM O NOVO NOME (ID---NOME.png)
        if (response.data && response.data.target_id && imageBase64) {
            const targetId = response.data.target_id;
            const imageBuffer = Buffer.from(imageBase64, 'base64');
            
            const imagePath = path.join(uploadsDir, `${targetId}---${name}.png`);
            fs.writeFileSync(imagePath, imageBuffer);
            console.log(`Cópia local guardada: ${imagePath}`);
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

        // Agora usamos a função buildSignature universal que garante o Content-MD5 correto!
        const signature = buildSignature(method, contentType, null, date, requestPath);
        const authHeader = `VWS ${ACCESS_KEY}:${signature}`;

        const response = await axios.delete(`https://vws.vuforia.com/targets/${targetId}`, {
            headers: { 'Authorization': authHeader, 'Date': date }
        });

        // Se apagou com sucesso no Vuforia, apaga a nossa imagem local
        if (response.status === 200 || response.status === 201) {
            const imagePath = path.join(uploadsDir, `${targetId}---${targetName}.png`);
            if (fs.existsSync(imagePath)) {
                fs.unlinkSync(imagePath);
                console.log(`Imagem local apagada: ${imagePath}`);
            }
        }

        res.json(response.data);
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.response?.data || error.message });
    }
});