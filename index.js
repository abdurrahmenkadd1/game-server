const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
app.use(cors());

const server = http.createServer(app);

// إعداد OpenAI (اختياري)
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "mock-key", 
});

const io = new Server(server, {
    cors: {
        origin: "*", // السماح للجميع
        methods: ["GET", "POST"]
    },
    transports: ['polling', 'websocket'] // نفس إعدادات الـ Client
});

// --- بيانات اللعبة ---
const WORDS_DB = {
    DEFAULT: ["بيتزا", "أسد", "طائرة", "بحر", "مدرسة", "قلم", "فراولة", "روبوت", "سيارة", "كرة قدم"],
    FOOD: ["برجر", "سوشي", "كباب", "منسف", "شاورما"],
    JOBS: ["طبيب", "مهندس", "طيار", "نجار", "مبرمج"]
};

let rooms = {};

// --- دوال مساعدة ---
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// استخراج بيانات اللاعب من المصافحة (Handshake)
// هذا يحل مشكلتك لأنك ترسل البيانات في الـ Auth
function getPlayerData(socket) {
    const auth = socket.handshake.auth || {};
    return {
        id: socket.id,
        name: auth.name || `Player ${socket.id.substr(0,4)}`,
        avatar: auth.avatar || '😀',
        coins: auth.coins || 0,
        isVip: auth.isVip || false,
        score: 0,
        isHost: false
    };
}

// --- منطق الاتصال ---
io.on('connection', (socket) => {
    console.log('✅ User Connected:', socket.id, 'Name:', socket.handshake.auth.name);

    // تخزين بيانات اللاعب في السوكيت نفسه لاستخدامها لاحقاً
    socket.userData = getPlayerData(socket);

   // 1. إنشاء غرفة
    socket.on('create_room', (hostData) => {
        const safeData = hostData || {}; 
        const roomCode = generateRoomCode();
        const hostName = safeData.name || "Host";
        const hostAvatar = safeData.avatar || "👑";

        rooms[roomCode] = {
            host: socket.id, // هذا هو الرقم المهم
            players: [{ id: socket.id, name: hostName, avatar: hostAvatar, score: 0, isHost: true }],
            gameState: 'LOBBY',
            gameData: {} 
        };
        
        socket.join(roomCode);
        
        // التعديل هنا: نرسل hostId بشكل صريح
        socket.emit('room_created', { 
            code: roomCode, 
            players: rooms[roomCode].players, 
            hostId: socket.id, // <-- هام جداً
            isHost: true 
        });
        console.log(`🏠 Room ${roomCode} created by ${hostName} (${socket.id})`);
    });
    
    // 2. انضمام لغرفة
    socket.on('join_room', (codeInput) => {
        if (!codeInput) return;
        const roomCode = codeInput.toUpperCase().trim();
        const room = rooms[roomCode];

        if (room) {
            // منع التكرار
            const existing = room.players.find(p => p.id === socket.id);
            if (!existing) {
                if (room.players.length >= 10) {
                    socket.emit('error', { message: "الغرفة ممتلئة" });
                    return;
                }
                
                const newPlayer = { ...socket.userData, isHost: false };
                room.players.push(newPlayer);
                socket.join(roomCode);
                
                // إرسال للأعضاء الجدد والقدامى
                socket.emit('joined_success', { code: roomCode, players: room.players });
                io.to(roomCode).emit('update_players', { 
                players: rooms[roomCode].players,
                hostId: rooms[roomCode].host // <-- هام جداً ليعرف الجميع من المضيف
                
            } else {
                // اللاعب موجود أصلاً، نعيد إرسال البيانات له
                socket.emit('joined_success', { code: roomCode, players: room.players });
            }
        } else {
            socket.emit('error', { message: "الغرفة غير موجودة" });
        }
    });

    // 3. مغادرة الغرفة
    socket.on('leave_room', () => {
        handleDisconnect(socket);
    });

    // 4. بدء اللعبة
    socket.on('start_game', ({ mode, category }) => {
        // البحث عن الغرفة التي فيها هذا اللاعب
        const roomCode = findRoomCodeBySocketId(socket.id);
        if (!roomCode) return;
        const room = rooms[roomCode];

        if (room && room.hostId === socket.id) {
            room.gameState = mode; // 'imposter' OR 'teams'
            let payload = {};

            if (mode === 'imposter') { // لاحظ الأحرف الصغيرة لتطابق App.tsx
                const list = WORDS_DB['DEFAULT'];
                const word = list[Math.floor(Math.random() * list.length)];
                const imposter = room.players[Math.floor(Math.random() * room.players.length)];
                
                payload = { 
                    mode: 'imposter',
                    data: {
                        word: word,
                        imposterId: imposter.id,
                        timeLeft: 60,
                        role: 'civilian' // سيتم تعديله لكل لاعب أدناه
                    }
                };

                // إرسال بيانات مختلفة لكل لاعب (ليعرف المحتال دوره)
                room.players.forEach(p => {
                    const isImposter = p.id === imposter.id;
                    const playerPayload = { ...payload };
                    playerPayload.data = { ...payload.data, role: isImposter ? 'imposter' : 'civilian', word: isImposter ? '???' : word };
                    io.to(p.id).emit('game_started', playerPayload);
                });

            } else if (mode === 'teams') {
                // تقسيم الفرق
                const shuffled = [...room.players].sort(() => 0.5 - Math.random());
                const mid = Math.ceil(shuffled.length / 2);
                const red = shuffled.slice(0, mid).map(p => ({...p, team: 'RED'}));
                const blue = shuffled.slice(mid).map(p => ({...p, team: 'BLUE'}));
                
                payload = {
                    mode: 'teams',
                    data: {
                        redTeam: red,
                        blueTeam: blue,
                        currentTurnTeam: 'RED'
                    }
                };
                io.to(roomCode).emit('game_started', payload);
            }
        }
    });

    // 5. طرد لاعب
    socket.on('kick_player', (playerId) => {
        const roomCode = findRoomCodeBySocketId(socket.id);
        if(!roomCode) return;
        const room = rooms[roomCode];

        if (room && room.hostId === socket.id) {
            room.players = room.players.filter(p => p.id !== playerId);
            io.to(roomCode).emit('player_list_updated', room.players);
            io.to(playerId).emit('kicked_out');
            io.sockets.sockets.get(playerId)?.leave(roomCode);
        }
    });

    // 6. استخدام البطاقات (للعبة الفرق)
    socket.on('play_card', ({ cardId, targetId }) => {
        const roomCode = findRoomCodeBySocketId(socket.id);
        if(roomCode) {
            io.to(roomCode).emit('toast_notification', { message: `تم استخدام بطاقة ${cardId}!` });
            // هنا يمكن إضافة منطق اللعبة الإضافي
        }
    });

    // قطع الاتصال
    socket.on('disconnect', () => {
        console.log('❌ Disconnected:', socket.id);
        handleDisconnect(socket);
    });
});

// --- دوال مساعدة داخلية ---

function findRoomCodeBySocketId(id) {
    for (let code in rooms) {
        if (rooms[code].players.find(p => p.id === id)) return code;
    }
    return null;
}

function handleDisconnect(socket) {
    const roomCode = findRoomCodeBySocketId(socket.id);
    if (roomCode) {
        const room = rooms[roomCode];
        room.players = room.players.filter(p => p.id !== socket.id);
        
        if (room.players.length === 0) {
            delete rooms[roomCode]; // حذف الغرفة إذا فرغت
        } else {
            io.to(roomCode).emit('player_list_updated', room.players);
            // إذا خرج المضيف، نعين مضيفاً جديداً
            if (socket.id === room.hostId) {
                room.hostId = room.players[0].id;
                room.players[0].isHost = true;
                io.to(roomCode).emit('player_list_updated', room.players);
            }
        }
        socket.leave(roomCode);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server Running on port ${PORT}`);
});

