const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// משיכת המפתחות מהגדרות השרת (Environment Variables)
const GREEN_API_ID = process.env.GREEN_API_ID || '7103982441'; 
const GREEN_API_TOKEN = process.env.GREEN_API_TOKEN || '1692237078334861933f92606440db97486e921d27574929a0';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; 
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1LUpyB8N-63EVOFCmzrolCm3mR0Mr6g8hAqtf7SfkUug/export?format=csv';

async function getSheetData() {
    try {
        const response = await axios.get(SHEET_URL);
        return response.data;
    } catch (error) {
        console.error("Error fetching sheet:", error);
        return "No inventory data available.";
    }
}

app.post('/webhook', async (req, res) => {
    try {
        const data = req.body;
        if (data.typeWebhook === 'incomingMessageReceived') {
            const chatId = data.senderData.chatId;
            const userMessage = data.messageData.textMessageData.textMessage;

            const inventory = await getSheetData();

            const aiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
                model: "gpt-4o-mini",
                messages: [
                    { 
                        role: "system", 
                        content: `אתה סוכן מכירות רכב מקצועי וכריזמטי בגואטמלה. 
                        הנה רשימת הרכבים המעודכנת מהמלאי שלנו:
                        ${inventory}
                        ענה ללקוח על בסיס הנתונים האלו. תהיה מכירתי, קצר (עד 50 מילים).
                        אם מבקשים תמונה, שלח את הלינק שמופיע בעמודת התמונות בשיטס.`
                    },
                    { role: "user", content: userMessage }
                ]
            }, {
                headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
            });

            const reply = aiResponse.data.choices[0].message.content;

            await axios.post(`https://7103.api.greenapi.com/waInstance${GREEN_API_ID}/sendMessage/${GREEN_API_TOKEN}`, {
                chatId: chatId,
                message: reply
            });
        }
        res.sendStatus(200);
    } catch (error) {
        console.error("Error:", error);
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
