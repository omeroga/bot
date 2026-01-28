const axios = require('axios');
const express = require('express');
const app = express();
app.use(express.json());

const config = {
    openaiKey: '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',
    greenApiId: '7103493933',
    greenApiToken: 'c446cd44a80b4266b471114f5aa73677fc9ce447f578402682',
    myGuatemalaNumber: '50231390807@c.us'
};

async function askChatGPT(userMessage) {
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "אתה איש מכירות מקצועי, חד וקצר. ענה תמיד בעברית." },
                { role: "user", content: userMessage }
            ]
        }, {
            headers: { 
                'Authorization': `Bearer ${config.openaiKey}`,
                'Content-Type': 'application/json' 
            }
        });
        return response.data.choices[0].message.content;
    } catch (e) {
        console.error("OpenAI Error:", e.response ? e.response.data : e.message);
        return "חלה שגיאה בעיבוד התשובה.";
    }
}

async function sendWhatsApp(targetChatId, text) {
    try {
        const url = `https://api.green-api.com/waInstance${config.greenApiId}/sendMessage/${config.greenApiToken}`;
        await axios.post(url, { chatId: targetChatId, message: text });
    } catch (e) {
        console.error("Green API Error");
    }
}

app.post('/webhook', async (req, res) => {
    try {
        if (req.body.typeWebhook === 'incomingMessageReceived') {
            const customerChatId = req.body.senderData.chatId;
            if (customerChatId === config.myGuatemalaNumber) {
                const incomingText = req.body.messageData.textMessageData.textMessage;
                const aiReply = await askChatGPT(incomingText);
                await sendWhatsApp(customerChatId, aiReply);
            }
        }
        res.sendStatus(200);
    } catch (e) {
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
