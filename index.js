const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// Secure environment variables
const GREEN_API_ID = process.env.GREEN_API_ID; 
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1LUpyB8N-63EVOFCmzrolCm3mR0Mr6g8hAqtf7SfkUug/export?format=csv';

app.post('/webhook', async (req, res) => {
    try {
        // Validation check
        if (!OPENAI_API_KEY) {
            console.error('❌ CRITICAL: OPENAI_API_KEY is missing in Render Environment Settings');
            return res.sendStatus(500);
        }

                const data = req.body;
        
        // This check ensures we only process actual text messages
        if (data.typeWebhook === 'incomingMessageReceived' && data.messageData?.textMessageData?.textMessage) {
            const chatId = data.senderData.chatId;
            const userMessage = data.messageData.textMessageData.textMessage;

            const sheetRes = await axios.get(SHEET_URL);
            const inventory = sheetRes.data;

            const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: `You are a professional car sales agent in Guatemala. Inventory: ${inventory} Rules: Use only provided data. Send links from 'Fotos' column for images. Respond in user language.` 
                    },
                    { role: "user", content: userMessage }
                ]
            }, {
                headers: { 
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'Content-Type': 'application/json'
                }
            });

            const reply = aiResponse.data.choices[0].message.content;

            await axios.post(`https://api.greenapi.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`, {
    chatId: chatId,
    message: reply
});
        }
        res.sendStatus(200);
    } catch (error) {
        // Advanced Error Logging
        if (error.response) {
            console.error("❌ OpenAI/HTTP Error Status:", error.response.status);
            console.error("❌ Error Body:", JSON.stringify(error.response.data));
        } else {
            console.error("❌ Connection Error:", error.message);
        }
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
