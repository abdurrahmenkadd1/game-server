const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
app.use(cors());

const server = http.createServer(app);

// إعداد OpenAI (سيعمل برد تلقائي إذا لم يوجد مفتاح)
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "mock-key", 
});

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// كلمات اللعبة
const WORDS_DB = {
    DEFAULT: ["بيتزا", "أسد", "طائرة", "بحر", "مدرسة", "قلم", "فراولة", "روبوت", "سيارة", "كرة قدم"],
    FOOD: ["برجر", "سوشي", "كباب", "منسف", "شاورما"],
    JOBS: ["طبيب", "مهندس", "طيار", "نجار", "مبرمج"]
};

let rooms = {};

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// دالة التلميح (تعمل حتى بدون ذكاء اصطناعي الآن)
async function getAIHint(characterName) {
    if (!process.env.OPENAI_API_KEY) {
        return `🤖 تلميح النظام: الشخصية تتكون من ${characterName.length} أحرف.`;
    }
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: `Give a hint about "${characterName}" in Arabic without naming it.` }],
            max_tokens: 60,
        });
        return response.choices[0].message.content;
    } catch (error) {
        return "تلميح: الشخصية مشهورة جداً!";
    }
}

io.on('connection', (socket) => {
    console.log('✅ User Connected:', socket.id);

    // إنشاء غرفة
    socket.on('create_room', (hostData) => {
        const roomCode = generateRoomCode();
        const hostName = hostData?.name || "Host";
        rooms[roomCode] = {
            host: socket.id,
            players: [{ id: socket.id, name: hostName, avatar: hostData.avatar, score: 0, isHost: true }],
            gameState: 'LOBBY',
            gameData: {}
        };
        socket.join(roomCode);
        socket.emit('room_created', { code: roomCode, players: rooms[roomCode].players, isHost: true });
    });

    // انضمام
    socket.on('join_room', (data) => {
        if (!data || !data.roomCode) return;
        const roomCode = data.roomCode.toUpperCase().trim();
        const room = rooms[roomCode];
        if (room) {
            const existing = room.players.find(p => p.id === socket.id);
            if (!existing) {
                if (room.players.length >= 10) {
                    socket.emit('error', { message: "الغرفة ممتلئة" });
                    return;
                }
                const pName = data.name || `Player ${room.players.length + 1}`;
                room.players.push({ id: socket.id, name: pName, avatar: data.avatar, score: 0, isHost: false });
                socket.join(roomCode);
            }
            socket.emit('joined_success', { code: roomCode, players: room.players, isHost: false });
            io.to(roomCode).emit('update_players', room.players);
        } else {
            socket.emit('error', { message: "الغرفة غير موجودة" });
        }
    });

    // بدء اللعبة
    socket.on('start_game', ({ roomCode, gameType, settings }) => {
        const room = rooms[roomCode];
        if (room && room.host === socket.id) {
            room.gameState = gameType;
            let payload = {};

            if (gameType === 'IMPOSTER') {
                const list = WORDS_DB['DEFAULT']; 
                const word = list[Math.floor(Math.random() * list.length)];
                const imposter = room.players[Math.floor(Math.random() * room.players.length)];
                payload = { word, imposterId: imposter.id };
            } 
            else if (gameType === 'CHARACTERS') {
                const shuffled = [...room.players].sort(() => 0.5 - Math.random());
                const mid = Math.ceil(shuffled.length / 2);
                const red = shuffled.slice(0, mid);
                const blue = shuffled.slice(mid);
                room.gameData = { redTeam: red, blueTeam: blue, redCharacter: null, blueCharacter: null };
                payload = { redTeam: red, blueTeam: blue, phase: 'SETUP' }; 
            }
            io.to(roomCode).emit('game_started', { gameType, gameData: payload });
        }
    });

    // استقبال الشخصيات
    socket.on('submit_character', ({ roomCode, team, character }) => {
        const room = rooms[roomCode];
        if (!room) return;
        if (team === 'RED') room.gameData.redCharacter = character;
        if (team === 'BLUE') room.gameData.blueCharacter = character;
        
        // إذا الفريقين جاهزين
        if (room.gameData.redCharacter && room.gameData.blueCharacter) {
            io.to(roomCode).emit('start_team_gameplay', { turn: 'RED' });
        }
    });

    // طلب تلميح
    socket.on('request_hint', async ({ roomCode, team }) => {
        const room = rooms[roomCode];
        if (room) {
            // الفريق الأحمر يريد تلميحاً عن شخصية الأزرق
            const targetChar = team === 'RED' ? room.gameData.blueCharacter : room.gameData.redCharacter;
            if (targetChar) {
                const hint = await getAIHint(targetChar);
                io.to(roomCode).emit('ai_hint_response', { text: hint });
            }
        }
    });
    
    // طرد
    socket.on('kick_player', ({ roomCode, playerId }) => {
        const room = rooms[roomCode];
        if (room && room.host === socket.id) {
            const idx = room.players.findIndex(p => p.id === playerId);
            if (idx !== -1) {
                room.players.splice(idx, 1);
                io.to(roomCode).emit('update_players', room.players);
                io.to(playerId).emit('kicked_out');
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server Running on port ${PORT}`);
});