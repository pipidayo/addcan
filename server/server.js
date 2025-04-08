const { createServer } = require('http')
const { Server } = require('socket.io')

const httpServer = createServer()
const io = new Server(httpServer, {
  cors: {
    origin: '*', // 開発中はすべてのオリジンを許可 (本番環境では制限してください)
    methods: ['GET', 'POST'],
  },
})

// ルーム情報を管理するオブジェクト
const rooms = {}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`)

  // ルーム参加イベント
  socket.on('join-room', ({ roomCode, peerId, name }) => {
    console.log(`${name} (${peerId}) joined room: ${roomCode}`)
    socket.join(roomCode)

    // ルームが存在しない場合は作成
    if (!rooms[roomCode]) {
      rooms[roomCode] = { participants: {} }
    }

    // 参加者リストにユーザーを追加
    rooms[roomCode].participants[peerId] = name

    // 既存の参加者情報を送信
    socket.emit('existing-participants', rooms[roomCode].participants)

    // 他の参加者に通知
    socket.to(roomCode).emit('user-joined', { peerId, name })
  })

  // ルーム退出イベント
  socket.on('leave-room', ({ roomCode, peerId }) => {
    console.log(`${peerId} left room: ${roomCode}`)
    socket.leave(roomCode)

    // 参加者リストからユーザーを削除
    if (rooms[roomCode] && rooms[roomCode].participants[peerId]) {
      delete rooms[roomCode].participants[peerId]
    }

    // 他の参加者に通知
    socket.to(roomCode).emit('user-left', { peerId })

    // ルームが空になったら削除
    if (
      rooms[roomCode] &&
      Object.keys(rooms[roomCode].participants).length === 0
    ) {
      delete rooms[roomCode]
      console.log(`Room ${roomCode} is now empty and has been removed.`)
    }
  })

  // 切断イベント
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`)
    // 退出処理 (どのルームから退出したか不明なので、全ルームをチェック)
    for (const roomCode in rooms) {
      for (const peerId in rooms[roomCode].participants) {
        if (peerId === socket.id) {
          socket.to(roomCode).emit('user-left', { peerId })
          delete rooms[roomCode].participants[peerId]
          if (Object.keys(rooms[roomCode].participants).length === 0) {
            delete rooms[roomCode]
            console.log(`Room ${roomCode} is now empty and has been removed.`)
          }
          break
        }
      }
    }
  })
})

const PORT = 3001
httpServer.listen(PORT, () => {
  console.log(`WebSocket server listening on port ${PORT}`)
})
