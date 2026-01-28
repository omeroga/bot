const axios = require('axios');
const express = require('express');
const app = express();
app.use(express.json());

const config = {
    openaiKey: 'Sk-proj-VgjNl4PTBnfVyOdYzIo8P1e4UoZkYmZ9KHX6tuX9BvivqIxoQ_XSDPVCnanAMaFBwRYyei8k6MT3BlbkFJgW_0VKSQh91oUt15KSJXwY5Oqqwel25r3NopMCOGHjh6CZBZ4998zXKZ2dy1B34Vpj2wTsHq4A',
    greenApiId: '7107492666',
    greenApiToken: '1cc247a0c53c4c77af473a0355748b499fd42250c1c54711bc',
    myGuatemalaNumber: '50231390807@c.us' // המספר היחיד שהבוט יגיב לו
};

// פונקציית המוח (ChatGPT)
async function askChatGPT(userMessage) {
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: "gpt-4o-mini",
            messages: [
                { 
                    role: "system", 
                    content: "אתה איש מכירות מקצועי, חד וקצר. ענה תמיד בעברית בצורה עניינית." 
                },
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
        console.error("OpenAI Error");
        return "חלה שגיאה בעיבוד התשובה.";
    }
}

// פונקציית השליחה (Green API)
async function sendWhatsApp(targetChatId, text) {
    try {
        const url = `https://api.green-api.com/waInstance${config.greenApiId}/sendMessage/${config.greenApiToken}`;
        await axios.post(url, { 
            chatId: targetChatId, 
            message: text 
        });
    } catch (e) {
        console.error("Green API Error");
    }
}

// ה-Webhook שמקבל את ההודעות
app.post('/webhook', async (req, res) => {
    try {
        const type = req.body.typeWebhook;
        
        if (type === 'incomingMessageReceived') {
            const senderData = req.body.senderData;
            const customerChatId = senderData.chatId;

            // בדיקת אבטחה: האם זה המספר הגואטמלי שלי?
            if (customerChatId === config.myGuatemalaNumber) {
                const messageData = req.body.messageData;
                
                if (messageData.typeMessage === 'textMessage') {
                    const incomingText = messageData.textMessageData.textMessage;
                    console.log(`[Message from Guatemala]: ${incomingText}`);

                    const aiReply = await askChatGPT(incomingText);
                    await sendWhatsApp(customerChatId, aiReply);
                    console.log(`[Bot Reply Sent]`);
                }
            } else {
                console.log(`[Ignored]: Message from ${customerChatId} - Not the test number.`);
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("Webhook Logic Error:", e.message);
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Bot is locked to: ${config.myGuatemalaNumber}`);
});
