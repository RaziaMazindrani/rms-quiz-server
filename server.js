const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3333;

// Get local IP address
function getLocalIP() {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  } catch (e) {
    console.log('Could not detect network interfaces, using localhost');
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIP();
const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN 
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://${LOCAL_IP}:${PORT}`;
const QUIZ_URL = `${PUBLIC_URL}/play`;

// Quiz questions
const questions = [
  {
    id: 1,
    question: "How many price plan events does HPP process per day at peak?",
    options: ["5 Million", "20 Million+", "100 Million", "1 Million"],
    correct: 1,
    timeLimit: 15
  },
  {
    id: 2,
    question: "What are the 5 sequential steps in the RMS advisory workflow?",
    options: [
      "Plan → Build → Test → Deploy → Monitor",
      "Demand → Supply → Rates/Price → Hurdles → Inventory",
      "Ingest → Process → Store → Analyze → Report",
      "Forecast → Price → Sell → Review → Repeat"
    ],
    correct: 1,
    timeLimit: 15
  },
  {
    id: 3,
    question: "What does RPO stand for in the RMS context?",
    options: [
      "Revenue Processing Operations",
      "Rate Plan Orchestrator",
      "Retail Pricing Optimizer",
      "Room Pricing Output"
    ],
    correct: 2,
    timeLimit: 15
  },
  {
    id: 4,
    question: "What is the availability SLO target for RMS?",
    options: ["99.00%", "99.95%", "99.999%", "95.00%"],
    correct: 1,
    timeLimit: 15
  },
  {
    id: 5,
    question: "🎬 If RMS team had a movie, what would it be called?",
    options: [
      "The Dark Knight Rates",
      "Spider-Man: No Way to Book",
      "Fast & Furious: Revenue Drift",
      "Avengers: Infinite Yield"
    ],
    correct: 3,
    timeLimit: 15
  }
];

// Game state
let gameState = {
  phase: 'waiting', // waiting, question, results, leaderboard
  currentQuestion: -1,
  players: new Map(), // socketId -> { name, score, answers: [] }
  questionStartTime: null,
  questionAnswers: new Map() // socketId -> { answer, time }
};

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// QR Code endpoint
app.get('/qr', async (req, res) => {
  try {
    const qr = await QRCode.toDataURL(QUIZ_URL, {
      width: 300,
      margin: 2,
      color: { dark: '#1d1d1f', light: '#ffffff' }
    });
    res.json({ qr, url: QUIZ_URL });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR' });
  }
});

// Player page
app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// Host/Presenter page (embedded in slides)
app.get('/host', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

// API endpoints
app.get('/api/state', (req, res) => {
  res.json({
    phase: gameState.phase,
    currentQuestion: gameState.currentQuestion,
    playerCount: gameState.players.size,
    players: Array.from(gameState.players.values()).map(p => ({ name: p.name, score: p.score }))
  });
});

app.get('/api/questions', (req, res) => {
  res.json({ total: questions.length });
});

// Socket.IO handling
io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  // Player joins
  socket.on('join', (name) => {
    const playerName = name.trim().substring(0, 20) || 'Anonymous';
    gameState.players.set(socket.id, {
      name: playerName,
      score: 0,
      answers: []
    });
    socket.join('players');
    
    // Send current state to player
    socket.emit('joined', { name: playerName, phase: gameState.phase });
    
    // Notify host
    io.to('host').emit('playerJoined', {
      count: gameState.players.size,
      players: Array.from(gameState.players.values()).map(p => p.name)
    });
    
    console.log(`Player joined: ${playerName} (Total: ${gameState.players.size})`);
  });

  // Host joins
  socket.on('hostJoin', () => {
    socket.join('host');
    socket.emit('hostState', {
      phase: gameState.phase,
      currentQuestion: gameState.currentQuestion,
      playerCount: gameState.players.size,
      players: Array.from(gameState.players.values()).map(p => p.name),
      totalQuestions: questions.length
    });
    console.log('Host connected');
  });

  // Host starts quiz
  socket.on('startQuiz', () => {
    gameState.phase = 'starting';
    gameState.currentQuestion = -1;
    io.emit('quizStarting');
    console.log('Quiz starting...');
  });

  // Host shows next question
  socket.on('nextQuestion', () => {
    gameState.currentQuestion++;
    
    if (gameState.currentQuestion >= questions.length) {
      // Quiz finished - show final leaderboard
      gameState.phase = 'leaderboard';
      const leaderboard = getLeaderboard();
      io.emit('showLeaderboard', { final: true, leaderboard });
      console.log('Quiz finished! Final leaderboard shown.');
      return;
    }

    const q = questions[gameState.currentQuestion];
    gameState.phase = 'question';
    gameState.questionStartTime = Date.now();
    gameState.questionAnswers.clear();

    // Send question to everyone
    io.emit('showQuestion', {
      questionNum: gameState.currentQuestion + 1,
      total: questions.length,
      question: q.question,
      options: q.options,
      timeLimit: q.timeLimit
    });

    console.log(`Question ${gameState.currentQuestion + 1}: ${q.question}`);

    // Auto-end question after time limit
    setTimeout(() => {
      if (gameState.phase === 'question' && 
          gameState.currentQuestion === questions.indexOf(q)) {
        endQuestion();
      }
    }, (q.timeLimit + 1) * 1000);
  });

  // Player submits answer
  socket.on('answer', (answerIndex) => {
    if (gameState.phase !== 'question') return;
    if (gameState.questionAnswers.has(socket.id)) return; // Already answered

    const timeTaken = (Date.now() - gameState.questionStartTime) / 1000;
    gameState.questionAnswers.set(socket.id, {
      answer: answerIndex,
      time: timeTaken
    });

    // Notify player their answer was received
    socket.emit('answerReceived');

    // Notify host of answer count
    io.to('host').emit('answerCount', {
      answered: gameState.questionAnswers.size,
      total: gameState.players.size
    });

    console.log(`Answer from ${gameState.players.get(socket.id)?.name}: ${answerIndex} (${timeTaken.toFixed(1)}s)`);
  });

  // Host ends question early
  socket.on('endQuestion', () => {
    if (gameState.phase === 'question') {
      endQuestion();
    }
  });

  // Host resets quiz
  socket.on('resetQuiz', () => {
    gameState.phase = 'waiting';
    gameState.currentQuestion = -1;
    gameState.questionAnswers.clear();
    // Reset scores but keep players
    for (const [id, player] of gameState.players) {
      player.score = 0;
      player.answers = [];
    }
    io.emit('quizReset');
    console.log('Quiz reset');
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (gameState.players.has(socket.id)) {
      const player = gameState.players.get(socket.id);
      gameState.players.delete(socket.id);
      io.to('host').emit('playerLeft', {
        count: gameState.players.size,
        name: player.name
      });
      console.log(`Player left: ${player.name}`);
    }
  });
});

function endQuestion() {
  gameState.phase = 'results';
  const q = questions[gameState.currentQuestion];
  
  // Calculate scores
  for (const [socketId, answerData] of gameState.questionAnswers) {
    const player = gameState.players.get(socketId);
    if (!player) continue;

    const isCorrect = answerData.answer === q.correct;
    let points = 0;
    
    if (isCorrect) {
      // Base points + time bonus (faster = more points)
      // Max 1000 points, min 500 for correct answer
      const timeBonus = Math.max(0, 1 - (answerData.time / q.timeLimit));
      points = Math.round(500 + (500 * timeBonus));
    }

    player.score += points;
    player.answers.push({
      questionId: q.id,
      answer: answerData.answer,
      correct: isCorrect,
      points,
      time: answerData.time
    });
  }

  // Mark players who didn't answer
  for (const [socketId, player] of gameState.players) {
    if (!gameState.questionAnswers.has(socketId)) {
      player.answers.push({
        questionId: q.id,
        answer: -1,
        correct: false,
        points: 0,
        time: null
      });
    }
  }

  const leaderboard = getLeaderboard();
  
  // Send results
  io.emit('questionResults', {
    correctAnswer: q.correct,
    correctText: q.options[q.correct],
    leaderboard: leaderboard.slice(0, 5),
    stats: {
      answered: gameState.questionAnswers.size,
      total: gameState.players.size,
      correctCount: Array.from(gameState.questionAnswers.values())
        .filter(a => a.answer === q.correct).length
    }
  });

  // Send individual results to each player
  for (const [socketId, player] of gameState.players) {
    const lastAnswer = player.answers[player.answers.length - 1];
    io.to(socketId).emit('yourResult', {
      correct: lastAnswer?.correct || false,
      points: lastAnswer?.points || 0,
      totalScore: player.score,
      rank: leaderboard.findIndex(p => p.name === player.name) + 1
    });
  }

  console.log(`Question ended. Correct: ${q.options[q.correct]}`);
}

function getLeaderboard() {
  return Array.from(gameState.players.values())
    .map(p => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================');
  console.log('   RMS QUIZ SERVER RUNNING');
  console.log('========================================');
  console.log(`\n   Local:    http://localhost:${PORT}`);
  console.log(`   Network:  http://${LOCAL_IP}:${PORT}`);
  console.log(`\n   Players join: ${QUIZ_URL}`);
  console.log('\n========================================\n');
});
