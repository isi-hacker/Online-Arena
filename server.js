const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage (use Redis/DB for production)
const users = new Map(); // username -> {password, stats, inventory}
const onlineUsers = new Map(); // socket.id -> user data
const rooms = new Map(); // roomId -> room data
const globalChat = [];

// Default weapons data
const WEAPONS = {
  m416: { name: 'M416', damage: 25, fireRate: 100, range: 100, type: 'rifle', ammo: 30 },
  m24: { name: 'M24', damage: 85, fireRate: 1000, range: 200, type: 'sniper', ammo: 5 },
  ump: { name: 'UMP45', damage: 30, fireRate: 120, range: 80, type: 'smg', ammo: 25 },
  shotgun: { name: 'M1014', damage: 15, fireRate: 400, range: 40, type: 'shotgun', ammo: 8, pellets: 8 },
  barett: { name: 'Barrett M82', damage: 100, fireRate: 1500, range: 250, type: 'sniper', ammo: 5 },
  knife: { name: 'Combat Knife', damage: 50, fireRate: 500, range: 3, type: 'melee', ammo: 1 },
  grenade: { name: 'Frag Grenade', damage: 80, fireRate: 2000, range: 30, type: 'throwable', ammo: 1, splash: 5 }
};

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/lobby', (req, res) => res.sendFile(path.join(__dirname, 'public', 'lobby.html')));
app.get('/game', (req, res) => res.sendFile(path.join(__dirname, 'public', 'game.html')));

// Socket.io handlers
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Login/Register
  socket.on('auth', (data) => {
    const { username, password, isRegister } = data;
    
    if (isRegister) {
      if (users.has(username)) {
        socket.emit('auth_error', 'Username already exists');
        return;
      }
      const hashedPass = bcrypt.hashSync(password, 10);
      users.set(username, {
        password: hashedPass,
        stats: { kills: 0, deaths: 0, wins: 0, games: 0 },
        inventory: {
          weapons: ['m416', 'knife'],
          equipped: { primary: 'm416', secondary: 'knife', melee: 'knife', throwable: null },
          skins: [],
          sensitivity: 1.0,
          controls: 'default'
        },
        settings: { sensitivity: 1.0, controls: 'wasd' }
      });
      socket.emit('auth_success', { username, isNew: true });
    } else {
      const user = users.get(username);
      if (!user || !bcrypt.compareSync(password, user.password)) {
        socket.emit('auth_error', 'Invalid credentials');
        return;
      }
      socket.emit('auth_success', { username, stats: user.stats, inventory: user.inventory });
    }
  });

  // Join lobby
  socket.on('join_lobby', (username) => {
    const userData = users.get(username);
    if (!userData) return;
    
    onlineUsers.set(socket.id, {
      username,
      socketId: socket.id,
      stats: userData.stats,
      inventory: userData.inventory
    });
    
    socket.join('lobby');
    socket.username = username;
    
    // Send global chat history
    socket.emit('chat_history', globalChat);
    
    // Notify others
    io.to('lobby').emit('user_joined', {
      username,
      onlineCount: onlineUsers.size
    });
    
    // Send room list
    socket.emit('room_list', Array.from(rooms.values()).map(r => ({
      id: r.id,
      name: r.name,
      host: r.host,
      players: r.players.length,
      maxPlayers: r.maxPlayers,
      mode: r.mode,
      isPrivate: r.isPrivate,
      status: r.status
    })));
  });

  // Global chat
  socket.on('global_chat', (message) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    
    const chatMsg = {
      id: uuidv4(),
      username: user.username,
      message: message.slice(0, 200),
      timestamp: Date.now()
    };
    
    globalChat.push(chatMsg);
    if (globalChat.length > 100) globalChat.shift();
    
    io.to('lobby').emit('new_message', chatMsg);
  });

  // Update inventory/settings
  socket.on('update_inventory', (data) => {
    const user = users.get(socket.username);
    if (!user) return;
    
    if (data.equipped) user.inventory.equipped = data.equipped;
    if (data.sensitivity) user.settings.sensitivity = data.sensitivity;
    if (data.controls) user.settings.controls = data.controls;
    
    socket.emit('inventory_updated', user.inventory);
  });

  // Create room
  socket.on('create_room', (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    
    const roomId = uuidv4().slice(0, 8);
    const room = {
      id: roomId,
      name: data.name || `${user.username}'s Room`,
      host: user.username,
      hostId: socket.id,
      players: [{ id: socket.id, username: user.username, team: 'lobby', ready: false }],
      maxPlayers: data.maxPlayers || 8,
      mode: data.mode || 'tdm',
      isPrivate: data.isPrivate || false,
      password: data.password || null,
      status: 'waiting',
      map: data.map || 'warehouse',
      teams: { red: [], blue: [] },
      scores: { red: 0, blue: 0, kills: {} }
    };
    
    rooms.set(roomId, room);
    socket.leave('lobby');
    socket.join(roomId);
    socket.roomId = roomId;
    
    socket.emit('room_created', room);
    io.to('lobby').emit('room_list_update', room);
  });

  // Join room
  socket.on('join_room', (data) => {
    const { roomId, password } = data;
    const room = rooms.get(roomId);
    const user = onlineUsers.get(socket.id);
    
    if (!room || !user) {
      socket.emit('join_error', 'Room not found');
      return;
    }
    
    if (room.isPrivate && room.password !== password) {
      socket.emit('join_error', 'Wrong password');
      return;
    }
    
    if (room.players.length >= room.maxPlayers) {
      socket.emit('join_error', 'Room full');
      return;
    }
    
    if (room.status !== 'waiting') {
      socket.emit('join_error', 'Game in progress');
      return;
    }
    
    const team = room.teams.red.length <= room.teams.blue.length ? 'red' : 'blue';
    room.players.push({ id: socket.id, username: user.username, team, ready: false });
    room.teams[team].push(socket.id);
    
    socket.leave('lobby');
    socket.join(roomId);
    socket.roomId = roomId;
    socket.team = team;
    
    io.to(roomId).emit('player_joined', {
      player: { id: socket.id, username: user.username, team },
      players: room.players,
      teams: room.teams
    });
    
    socket.emit('joined_room', room);
  });

  // Ready up
  socket.on('player_ready', (isReady) => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (player) player.ready = ready;
    
    io.to(socket.roomId).emit('player_ready_update', { playerId: socket.id, ready: isReady });
    
    // Check if all ready and start game
    const allReady = room.players.every(p => p.ready);
    if (allReady && room.players.length >= 2) {
      startGame(room);
    }
  });

  // Start game
  function startGame(room) {
    room.status = 'playing';
    room.scores = { red: 0, blue: 0, kills: {} };
    room.players.forEach(p => {
      room.scores.kills[p.username] = 0;
      p.health = 100;
      p.deaths = 0;
      p.spawned = false;
    });
    
    io.to(room.id).emit('game_start', {
      map: room.map,
      mode: room.mode,
      players: room.players.map(p => ({
        id: p.id,
        username: p.username,
        team: p.team,
        position: getSpawnPoint(room.map, p.team)
      }))
    });
  }

  function getSpawnPoint(map, team) {
    const spawns = {
      warehouse: {
        red: [{ x: -20, y: 2, z: -20 }, { x: -25, y: 2, z: -15 }],
        blue: [{ x: 20, y: 2, z: 20 }, { x: 25, y: 2, z: 15 }]
      }
    };
    const teamSpawns = spawns[map][team];
    return teamSpawns[Math.floor(Math.random() * teamSpawns.length)];
  }

  // In-game actions
  socket.on('player_spawn', () => {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.health = 100;
      player.spawned = true;
      const spawn = getSpawnPoint(room.map, player.team);
      socket.emit('spawned', { position: spawn, health: 100 });
      socket.to(socket.roomId).emit('enemy_spawned', { id: socket.id, position: spawn, team: player.team });
    }
  });

  socket.on('player_move', (data) => {
    socket.to(socket.roomId).emit('enemy_move', {
      id: socket.id,
      position: data.position,
      rotation: data.rotation,
      animation: data.animation
    });
  });

  socket.on('player_shoot', (data) => {
    const room = rooms.get(socket.roomId);
    const player = room?.players.find(p => p.id === socket.id);
    if (!player || player.health <= 0) return;
    
    const weapon = WEAPONS[data.weapon];
    if (!weapon) return;
    
    // Broadcast shot to others
    socket.to(socket.roomId).emit('enemy_shoot', {
      id: socket.id,
      weapon: data.weapon,
      origin: data.origin,
      direction: data.direction
    });
    
    // Check hits (server-side validation)
    if (data.hits) {
      data.hits.forEach(hit => {
        const target = room.players.find(p => p.id === hit.id);
        if (target && target.team !== player.team && target.health > 0) {
          let damage = weapon.damage;
          if (weapon.type === 'shotgun') damage *= (hit.distance < 10 ? 1 : 0.5);
          if (hit.hitZone === 'head') damage *= 2;
          
          target.health -= damage;
          
          if (target.health <= 0) {
            handleKill(room, player, target, weapon);
          } else {
            io.to(target.id).emit('player_damaged', { damage, health: target.health, attacker: player.username });
          }
        }
      });
    }
  });

  function handleKill(room, killer, victim, weapon) {
    victim.health = 0;
    victim.deaths++;
    room.scores.kills[killer.username]++;
    
    if (room.mode === 'tdm') {
      room.scores[killer.team]++;
    } else {
      room.scores[killer.username] = (room.scores[killer.username] || 0) + 1;
    }
    
    io.to(room.id).emit('player_killed', {
      killer: killer.username,
      victim: victim.username,
      weapon: weapon.name,
      teamScores: room.mode === 'tdm' ? { red: room.scores.red, blue: room.scores.blue } : null,
      scores: room.scores
    });
    
    // Check win conditions
    if (room.mode === 'tdm') {
      if (room.scores.red >= 50 || room.scores.blue >= 50) {
        endGame(room, room.scores.red >= 50 ? 'red' : 'blue');
      }
    } else {
      const leader = Object.entries(room.scores).sort((a, b) => b[1] - a[1])[0];
      if (leader[1] >= 20) endGame(room, null, leader[0]);
    }
    
    // Respawn timer
    setTimeout(() => {
      if (room.status === 'playing') {
        victim.health = 100;
        const spawn = getSpawnPoint(room.map, victim.team);
        io.to(victim.id).emit('can_respawn', { position: spawn });
      }
    }, 3000);
  }

  function endGame(room, winningTeam, winningPlayer) {
    room.status = 'ended';
    const winners = winningTeam ? room.players.filter(p => p.team === winningTeam).map(p => p.username) : [winningPlayer];
    
    io.to(room.id).emit('game_end', {
      winners,
      winningTeam,
      finalScores: room.scores,
      stats: room.players.map(p => ({
        username: p.username,
        kills: room.scores.kills[p.username] || 0,
        deaths: p.deaths
      }))
    });
    
    // Update user stats
    room.players.forEach(p => {
      const user = users.get(p.username);
      if (user) {
        user.stats.games++;
        user.stats.kills += room.scores.kills[p.username] || 0;
        user.stats.deaths += p.deaths;
        if (winners.includes(p.username)) user.stats.wins++;
      }
    });
  }

  // In-game chat
  socket.on('game_chat', (message) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    
    io.to(socket.roomId).emit('game_message', {
      username: user.username,
      message: message.slice(0, 100),
      team: socket.team,
      timestamp: Date.now()
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const room = rooms.get(socket.roomId);
    if (room) {
      room.players = room.players.filter(p => p.id !== socket.id);
      room.teams.red = room.teams.red.filter(id => id !== socket.id);
      room.teams.blue = room.teams.blue.filter(id => id !== socket.id);
      
      if (room.players.length === 0) {
        rooms.delete(socket.roomId);
      } else {
        if (room.hostId === socket.id) {
          room.hostId = room.players[0].id;
          room.host = room.players[0].username;
        }
        io.to(socket.roomId).emit('player_left', { id: socket.id, newHost: room.host });
      }
    }
    
    onlineUsers.delete(socket.id);
    io.to('lobby').emit('user_left', { 
      username: socket.username, 
      onlineCount: onlineUsers.size 
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`FPS Server running on port ${PORT}`);
});