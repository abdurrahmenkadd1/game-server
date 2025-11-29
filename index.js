const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
app.use(cors());

const server = http.createServer(app);

// 1. إعداد OpenAI (الحكم الذكي)
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "mock-key", 
});

const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    },
    transports: ['polling', 'websocket']
});

// 2. قاعدة بيانات الكلمات (Imposter Game)
const WORDS_DB = {
    DEFAULT: ["بيتزا", "أسد", "طائرة", "بحر", "مدرسة", "قلم", "فراولة", "روبوت", "سيارة", "كرة قدم"],
    food: ["برجر", "سوشي", "كباب", "منسف", "شاورما", "آيس كريم", "فلافل"],
    animals: ["فيل", "زرافة", "بطريق", "صقر", "دلفين", "كنغر", "نمر", "ذئب"],
    jobs: ["طبيب", "مهندس", "طيار", "نجار", "مبرمج", "رائد فضاء"],
    brands: ["آبل", "سامسونج", "نايكي", "مرسيدس", "بيبسي", "تويوتا"]
};

let rooms = {};

// --- دوال مساعدة ---
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// استخراج بيانات اللاعب من المصافحة (Handshake Auth)
// هذا يطابق تماماً ما ترسله في socketService.connect
function getPlayerData(socket) {
    const auth = socket.handshake.auth || {};
    return {
        id: socket.id,
        name: auth.name || `Player ${socket.id.substr(0,4)}`,
        avatar: auth.avatar || '😀',
        coins: auth.coins || 500, // الرصيد الافتراضي
        isVip: auth.isVip || false,
        score: 0,
        isHost: false
    };
}

// دالة التلميح الذكي (للبطاقات)
async function generateAIHint(characterName) {
    if (!process.env.OPENAI_API_KEY) {
        return `🤖 الحكم الذكي: الشخصية تتكون من ${characterName.length} حروف.`;
    }
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: `Give a cryptic hint about "${characterName}" in Arabic.` }],
            max_tokens: 60,
        });
        return `🤖 الحكم: ${response.choices[0].message.content}`;
    } catch (e) {
        return "🤖 الحكم: تلميح عام - الشخصية مشهورة!";
    }
}

// --- بداية الاتصال ---
io.on('connection', (socket) => {
    console.log('✅ Connected:', socket.id);
    socket.userData = getPlayerData(socket);

    // --- 1. إنشاء غرفة ---
    socket.on('create_room', () => {
        const roomCode = generateRoomCode();
        const hostPlayer = { ...socket.userData, isHost: true };

        rooms[roomCode] = {
            code: roomCode,
            hostId: socket.id,
            players: [hostPlayer],
            gameState: 'LOBBY',
            teamData: { redTeam: [], blueTeam: [], selections: {} }
        };
        
        socket.join(roomCode);
        // الرد المطابق لـ App.tsx
        socket.emit('room_created', { 
            code: roomCode, 
            players: rooms[roomCode].players,
            isHost: true 
        });
    });

    // --- 2. انضمام ---
    socket.on('join_room', (code) => {
        if (!code) return;
        const roomCode = code.toUpperCase().trim();
        const room = rooms[roomCode];

        if (room) {
            const existing = room.players.find(p => p.id === socket.id);
            if (!existing) {
                if (room.players.length >= 8) {
                    socket.emit('error', { message: "الغرفة ممتلئة" });
                    return;
                }
                const newPlayer = { ...socket.userData, isHost: false };
                room.players.push(newPlayer);
                socket.join(roomCode);
            }
            
            // إرسال النجاح
            socket.emit('joined_success', { 
                code: roomCode, 
                players: room.players,
                isHost: false 
            });
            
            // تحديث القائمة للجميع (مع hostId ليقوم App.tsx بتحديد المضيف)
            io.to(roomCode).emit('update_players', { 
                players: room.players, 
                hostId: room.hostId 
            });
        } else {
            socket.emit('error', { message: "الغرفة غير موجودة" });
        }
    });

    // --- 3. مغادرة ---
    socket.on('leave_room', () => {
        handleDisconnect(socket);
    });

    // --- 4. بدء اللعبة ---
    socket.on('start_game', ({ mode, category }) => { // App.tsx يرسل 'mode' وليس 'gameType'
        const roomCode = findRoomCodeBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];

        if (room && room.hostId === socket.id) {
            room.gameState = mode;
            let payload = {};

            // أ. لعبة المحتال
            if (mode === 'imposter') {
                // اختيار كلمة حسب الفئة
                const catKey = category || 'DEFAULT';
                const list = WORDS_DB[catKey] || WORDS_DB.DEFAULT;
                const word = list[Math.floor(Math.random() * list.length)];
                const imposter = room.players[Math.floor(Math.random() * room.players.length)];
                
                payload = { 
                    mode: 'imposter',
                    data: {
                        word: word,
                        imposterId: imposter.id,
                        timeLeft: 60,
                        role: 'civilian', // Placeholder
                        category: catKey
                    }
                };

                // إرسال مخصص لكل لاعب (لكشف المحتال لنفسه فقط)
                room.players.forEach(p => {
                    const isImposter = p.id === imposter.id;
                    const pPayload = JSON.parse(JSON.stringify(payload));
                    pPayload.data.role = isImposter ? 'imposter' : 'civilian';
                    if (isImposter) pPayload.data.word = "???"; // إخفاء الكلمة عن المحتال
                    io.to(p.id).emit('game_started', pPayload);
                });

            } 
            // ب. لعبة الفرق
            else if (mode === 'teams') {
                // خ
