const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const GREEN_API_ID = process.env.GREEN_API_ID || '7103982441'; 
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN || '1692237078334861933f92606440db97486e921d27574929a0';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY.trim() : null;
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1LUpyB8N-63EVOFCmzrolCm3mR0Mr6g8hAqtf7SfkUug/export?format=csv';

async function getSheetData() {
    try {
        const response = await axios.get(SHEET_URL);
        return response.data;
    } catch (error) {
        console.error("Sheet Fetch Error:", error.message);
        return "No inventory data available.";
    }
}

app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        if (data.typeWebhook === 'incomingMessageReceived' && OPENAI_API_KEY) {
            const chatId = data.senderData.chatId;
            const userMessage = data.messageData.textMessageData.textMessage;

            const inventory = await getSheetData();

            const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: `You are a professional car sales agent in Guatemala. 
                        Use the following CSV inventory data to answer:
                        ${inventory}
                        
                        Rules:
                        1. Answer only based on the provided data.
                        2. If asked for a photo, provide the link from the image column.
                        3. Be sales-oriented, professional, and concise.
                        4. Respond in the same language as the customer (Hebrew or Spanish).`
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

            await axios.post(`https://7103.api.greenapi.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`, {
                chatId: chatId,
                message: reply
            });
        }
        res.sendStatus(200);
    } catch (error) {
        if (error.response) {
            console.error("OpenAI Error:", error.response.status, JSON.stringify(error.response.data));
        } else {
            console.error("Internal Error:", error.message);
        }
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
