// server.js (修正版 - check-room-exists イベントハンドラ追加)

const { createServer } = require('http')
const { Server } = require('socket.io')

const httpServer = createServer()
const io = new Server(httpServer, {
  cors: {
    origin: '*', // 本番環境では適切なオリジンを指定してください
    methods: ['GET', 'POST'],
  },
})

const rooms = {} // { roomCode: { peerId: name, ... }, ... }

io.on('connection', (socket) => {
  console.log(`Connection handler started for socket ID: ${socket.id}`)
  console.log(`User connected: ${socket.id}`)

  // socket オブジェクトにカスタムプロパティを追加して情報を保持
  socket.currentPeerId = null
  socket.currentRoomCode = null

  // ルーム参加イベント
  socket.on('join-room', ({ roomCode, peerId, name }) => {
    if (!roomCode || !peerId || !name) {
      console.warn('[Server] Invalid join-room payload:', {
        roomCode,
        peerId,
        name,
      })
      return
    }
    console.log(
      `[Server] Received join-room from ${peerId} for room ${roomCode}`
    )

    // socket に情報を記録
    socket.currentPeerId = peerId
    socket.currentRoomCode = roomCode

    // 部屋が存在しなければ作成
    if (!rooms[roomCode]) {
      rooms[roomCode] = {}
      console.log(`[Server] Room created: ${roomCode}`)
    }

    // 既存の参加者リストを取得 (自分自身を除く)
    const existingParticipants = { ...rooms[roomCode] }
    console.log(
      `[Server join-room] Preparing 'existing-participants' for ${peerId}. Data:`,
      JSON.stringify(existingParticipants)
    )

    // 部屋に参加 & 参加者を追加/更新
    socket.join(roomCode)
    // 既に同じ Peer ID があれば名前を更新、なければ追加
    rooms[roomCode][peerId] = name
    console.log(`${name} (${peerId}) joined/updated room: ${roomCode}`)
    console.log(
      '[Server join-room] Current rooms state AFTER join:',
      JSON.stringify(rooms)
    )

    // 他の参加者に通知 (自分自身を除く)
    console.log(
      `[Server join-room] Broadcasting 'user-joined' to room ${roomCode}. Payload:`,
      { peerId, name }
    )
    socket.to(roomCode).emit('user-joined', { peerId, name }) // socket.to() は自分以外の全員に送信

    // 参加者に既存の参加者リストを送信 (自分自身を除外したリストを送信)
    const participantsToSend = { ...existingParticipants } // コピーを作成
    console.log(
      `[Server join-room] Sending 'existing-participants' to ${peerId}. Payload:`,
      JSON.stringify(participantsToSend)
    )
    socket.emit('existing-participants', participantsToSend)
  })

  // ★★★ ここから追加: 部屋存在確認イベント ★★★
  socket.on('check-room-exists', ({ roomCode }, callback) => {
    if (!roomCode) {
      // roomCode がなければ false を返す
      if (typeof callback === 'function') {
        callback({ exists: false })
      }
      return
    }
    // rooms オブジェクトに roomCode が存在するか確認 (rooms[roomCode] が undefined でないか)
    const roomExists = rooms.hasOwnProperty(roomCode) // hasOwnProperty を使う方がより安全
    console.log(
      `[Server check-room-exists] Room ${roomCode} exists: ${roomExists}`
    )
    // 結果をコールバックでクライアントに返す
    if (typeof callback === 'function') {
      callback({ exists: roomExists })
    } else {
      // コールバックがない場合 (念のためログ)
      console.warn(
        `[Server check-room-exists] No callback provided for room check: ${roomCode}`
      )
    }
  })
  // ★★★ ここまで追加 ★★★

  // 切断イベント
  socket.on('disconnect', () => {
    console.log(`[Server] disconnect event for socket ID: ${socket.id}`)
    // socket に記録された情報を使用
    const peerId = socket.currentPeerId
    const roomCode = socket.currentRoomCode

    console.log(
      `[Server disconnect] Before cleanup: Peer ID: ${peerId}, Room: ${roomCode}`
    )
    console.log(
      '[Server disconnect] Current rooms state BEFORE delete:',
      JSON.stringify(rooms)
    )

    // ユーザーが部屋に参加していた場合のみ処理
    if (roomCode && peerId && rooms[roomCode]) {
      if (rooms[roomCode][peerId]) {
        console.log(
          `[Server disconnect] Removing ${peerId} (${rooms[roomCode][peerId]}) from room ${roomCode}`
        )
        delete rooms[roomCode][peerId] // 部屋からユーザーを削除

        // 他の参加者に退出を通知
        console.log(
          `[Server disconnect] Broadcasting 'user-left' to room ${roomCode}. Payload:`,
          { peerId }
        )
        io.to(roomCode).emit('user-left', { peerId })

        // 部屋に誰もいなくなったら部屋を削除
        if (Object.keys(rooms[roomCode]).length === 0) {
          console.log(
            `[Server disconnect] Room ${roomCode} is empty, deleting room.`
          )
          delete rooms[roomCode]
        }
      } else {
        console.warn(
          `[Server disconnect] Peer ID ${peerId} not found in room ${roomCode} upon disconnect.`
        )
      }
    } else {
      console.log(
        `[Server disconnect] User ${socket.id} (Peer ID: ${peerId}) was not in a room or room data inconsistent.`
      )
    }
    console.log(
      '[Server disconnect] Current rooms state AFTER delete:',
      JSON.stringify(rooms)
    )
  })

  console.log(
    `Connection handler finished setting up listeners for socket ID: ${socket.id}`
  )
})

const PORT = 3001
httpServer.listen(PORT, () => {
  console.log(`WebSocket server listening on port ${PORT}`)
})
