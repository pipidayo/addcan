// server.js (修正版 - check-room-exists イベントハンドラ追加)
console.log(
  '[SERVER SCRIPT START] server.js is being executed. Timestamp:',
  new Date().toISOString()
)

const { createServer } = require('http')
const { Server } = require('socket.io')

// HTTPサーバーを作成し、基本的なリクエストに応答できるようにする
const httpServer = createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    // 例: /health エンドポイント
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('OK')
  } else if (req.url === '/' && req.method === 'GET') {
    // 例: ルートパスへの応答
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Socket.IO Server is running')
  } else {
  }
})

const IS_PRODUCTION = process.env.NODE_ENV === 'production'

const port = process.env.PORT || 10000 // Renderが提供するPORT環境変数を使用。なければローカル開発用に10000など。

function debugLog(...args) {
  if (!IS_PRODUCTION) {
    console.log(...args)
  }
}

debugLog(`[Server ENV] 環境変数 process.env.PORT の値: ${process.env.PORT}`)
debugLog(`[Server ENV] サーバーが使用するポート: ${port}`)

// --- Renderデバッグ用に追加 ---
console.log(`[SERVER DEBUG] Raw process.env.PORT: ${process.env.PORT}`)
console.log(`[SERVER DEBUG] IS_PRODUCTION: ${IS_PRODUCTION}`)
console.log(`[SERVER DEBUG] Calculated port: ${port}`)
// --- Renderデバッグ用ここまで ---

httpServer.listen(port, '0.0.0.0', () => {
  // 明示的に 0.0.0.0 でリッスン
  console.log(`WebSocket server listening on 0.0.0.0:${port}`)
})

const io = new Server(httpServer, {
  cors: {
    origin: [
      'https://addcan-git-master-pipidayos-projects.vercel.app',
      'https://addcan.vercel.app', // 本番用ドメイン
      'http://localhost:3000', // ローカル開発用
    ],
    methods: ['GET', 'POST'], // methods も cors オブジェクト内に移動
  },
})

const rooms = {}
const peerIdToSocketId = new Map()

io.on('connection', (socket) => {
  debugLog(`[Server] Connection handler started for socket ID: ${socket.id}`)
  debugLog(`[Server] User connected: ${socket.id}`)

  // socket オブジェクトにカスタムプロパティを追加して情報を保持
  socket.currentPeerId = null
  socket.currentRoomCode = null

  // --- ルーム参加イベント ---
  socket.on('join-room', ({ roomCode, peerId, name }) => {
    if (!roomCode || !peerId || !name) {
      console.warn('[Server] Invalid join-room payload:', {
        roomCode,
        peerId,
        name,
      })
      return
    }
    debugLog(`[Server] Received join-room from ${peerId} for room ${roomCode}`)

    // 以前の接続情報があればクリーンアップ (念のため)
    // (同じ peerId で再接続した場合など)
    const oldSocketId = peerIdToSocketId.get(peerId)
    if (oldSocketId && oldSocketId !== socket.id) {
      debugLog(`[Server] Cleaning up old socket mapping for peer ${peerId}`)
      // 必要であれば、古いソケットに関連するルーム情報などもクリーンアップ
      const oldSocket = io.sockets.sockets.get(oldSocketId)
      if (oldSocket) {
        // 古いソケットを強制的に退出させるなどの処理も可能
      }
    }

    socket.currentPeerId = peerId
    socket.currentRoomCode = roomCode
    //  Peer ID と Socket ID を紐付け
    peerIdToSocketId.set(peerId, socket.id)
    debugLog(`[Server] Mapped peer ${peerId} to socket ${socket.id}`)

    // 部屋が存在しなければ作成
    if (!rooms[roomCode]) {
      // ★ 部屋の初期構造を変更 ★
      rooms[roomCode] = {
        participants: {},
        sharerPeerId: null, // 共有者は最初はいない
      }
      debugLog(`[Server] Room created: ${roomCode}`)
    }

    const room = rooms[roomCode] // 以降 room 変数を使用

    // 既存の参加者リストを取得 (自分自身を除く)
    const existingParticipants = { ...room.participants } // ★ participants から取得
    debugLog(
      `[Server join-room] Preparing 'existing-participants' for ${peerId}. Data:`,
      JSON.stringify(existingParticipants)
    )

    socket.join(roomCode)
    // 参加者を追加/更新
    room.participants[peerId] = name // ★ participants に追加
    debugLog(`${name} (${peerId}) joined/updated room: ${roomCode}`)
    debugLog(
      '[Server join-room] Current rooms state AFTER join:',
      JSON.stringify(rooms) // デバッグ用に rooms 全体を出力
    )

    // 他の参加者に通知 (自分自身を除く)
    debugLog(
      `[Server join-room] Broadcasting 'user-joined' to room ${roomCode}. Payload:`,
      { peerId, name }
    )
    socket.to(roomCode).emit('user-joined', { peerId, name })

    //  新しい参加者への画面共有開始を通知
    if (room.sharerPeerId && room.sharerPeerId !== peerId) {
      const sharerSocketId = peerIdToSocketId.get(room.sharerPeerId) // ★ 共有者の Socket ID を取得
      if (sharerSocketId) {
        const sharerSocket = io.sockets.sockets.get(sharerSocketId) // ★ 共有者の Socket オブジェクトを取得
        if (sharerSocket) {
          debugLog(
            `[Server] Notifying sharer ${room.sharerPeerId} (socket ${sharerSocketId}) to share with new peer ${peerId}`
          )
          // ★ 共有者だけに通知を送信
          sharerSocket.emit('initiate-screen-share-to-new-peer', {
            newPeerId: peerId,
          })
        } else {
          console.warn(
            `[Server] Could not find socket object for sharer socket ID ${sharerSocketId}`
          )
        }
      } else {
        console.warn(
          `[Server] Could not find socket ID mapping for sharer peer ID ${room.sharerPeerId}`
        )
      }
    }

    // 参加者に既存の参加者リストと現在の共有者IDを送信
    const participantsToSend = { ...existingParticipants }
    debugLog(
      `[Server join-room] Sending 'room-state' to ${peerId}. Payload:`,
      JSON.stringify({
        participants: participantsToSend,
        currentSharerId: room.sharerPeerId,
      }) // ★ currentSharerId も送信
    )
    // ★ イベント名を変更 (またはクライアント側でペイロードを調整)
    socket.emit('room-state', {
      // 'existing-participants' から変更
      participants: participantsToSend,
      currentSharerId: room.sharerPeerId,
    })
  })

  // ここから追加: 部屋存在確認イベント
  socket.on('check-room-exists', ({ roomCode }, callback) => {
    if (!roomCode) {
      if (typeof callback === 'function') callback({ exists: false })
      return
    }
    const roomExists = rooms.hasOwnProperty(roomCode)
    debugLog(
      `[Server check-room-exists] Room ${roomCode} exists: ${roomExists}`
    )
    if (typeof callback === 'function') {
      callback({ exists: roomExists })
    } else {
      console.warn(
        `[Server check-room-exists] No callback provided for room check: ${roomCode}`
      )
    }
  })

  // --- ★ 画面共有開始リクエスト ---
  socket.on('request-start-share', (callback) => {
    const peerId = socket.currentPeerId
    const roomCode = socket.currentRoomCode

    // 部屋に参加しているか、情報が正しいか確認
    if (!roomCode || !peerId || !rooms[roomCode]) {
      console.warn('[Server request-start-share] User not in a valid room:', {
        peerId,
        roomCode,
      })
      if (typeof callback === 'function') {
        // callback が関数か確認してから呼ぶ
        callback({ success: false, message: 'Not in a valid room.' })
      }
      return
    }

    const room = rooms[roomCode]

    if (room.sharerPeerId === null) {
      // 誰も共有していない -> 共有開始OK
      room.sharerPeerId = peerId // 共有者IDを設定
      debugLog(
        `[Server request-start-share] User ${peerId} allowed to share in room ${roomCode}.`
      )
      debugLog(
        `[Server request-start-share] Calling callback with success: true for ${peerId}`
      )

      // 共有開始を許可する応答を返す
      if (typeof callback === 'function') callback({ success: true })
      // 部屋の全員に通知 (新しい共有者情報をブロードキャスト)
      io.to(roomCode).emit('screen-share-status', {
        peerId: peerId, // 誰が共有を開始したか
        isSharing: true, // 共有が開始されたこと
        sharerPeerId: peerId, // 現在の共有者ID (冗長かもしれないが明確化のため)
      })
    } else {
      // 既に誰かが共有中 -> 共有開始NG
      debugLog(
        `[Server request-start-share] User ${peerId} denied sharing in room ${roomCode} (Already shared by ${room.sharerPeerId}).`
      )
      debugLog(
        `[Server request-start-share] Calling callback with success: false for ${peerId}`
      )

      // 共有開始を拒否する応答を返す
      if (typeof callback === 'function')
        callback({
          success: false,
          message: 'Another user is already sharing.',
        })
    }
  })

  // --- ★ 画面共有停止通知 ---
  socket.on('notify-stop-share', () => {
    const peerId = socket.currentPeerId
    const roomCode = socket.currentRoomCode

    // 部屋に参加しているか、情報が正しいか確認
    if (!roomCode || !peerId || !rooms[roomCode]) {
      console.warn('[Server notify-stop-share] User not in a valid room:', {
        peerId,
        roomCode,
      })
      return
    }

    const room = rooms[roomCode]

    if (room.sharerPeerId === peerId) {
      // 自分が共有者だった場合 -> 停止処理
      debugLog(
        `[Server notify-stop-share] User ${peerId} stopped sharing in room ${roomCode}.`
      )
      room.sharerPeerId = null // 共有者IDをリセット
      // 部屋の全員に通知 (共有が停止したことをブロードキャスト)
      io.to(roomCode).emit('screen-share-status', {
        peerId: peerId, // 誰が共有を停止したか
        isSharing: false, // 共有が停止されたこと
        sharerPeerId: null, // 現在の共有者ID
      })
    } else {
      // 共有者でないのに停止通知が来た場合 (基本的には起こらないはずだがログ)
      console.warn(
        `[Server notify-stop-share] User ${peerId} tried to stop sharing in room ${roomCode}, but current sharer is ${room.sharerPeerId}.`
      )
    }
  })

  // --- 切断イベント ---
  socket.on('disconnect', () => {
    debugLog(`[Server] disconnect event for socket ID: ${socket.id}`)
    const peerId = socket.currentPeerId
    const roomCode = socket.currentRoomCode

    // ユーザーが部屋に参加していたか、情報が正しく設定されていたか確認
    if (!roomCode || !peerId || !rooms[roomCode]) {
      debugLog(
        `[Server disconnect] User ${socket.id} (Peer ID: ${peerId}) was not in a room or room data inconsistent. No room cleanup needed.`
      )
      return // 部屋に参加していなかった場合はここで終了
    }

    // Peer ID と Socket ID の紐付けを解除
    if (peerId) {
      peerIdToSocketId.delete(peerId)
      debugLog(`[Server] Unmapped peer ${peerId} from socket ${socket.id}`)
    }

    debugLog(
      `[Server disconnect] Before cleanup: Peer ID: ${peerId}, Room: ${roomCode}`
    )
    debugLog(
      '[Server disconnect] Current rooms state BEFORE delete:',
      JSON.stringify(rooms)
    )

    const room = rooms[roomCode] // room 変数を使用

    if (room.participants[peerId]) {
      // ★ participants を確認
      debugLog(
        `[Server disconnect] Removing ${peerId} (${room.participants[peerId]}) from room ${roomCode}`
      )

      // ★ 共有者だったかどうかをチェック ★
      const wasSharing = room.sharerPeerId === peerId

      delete room.participants[peerId] // ★ participants から削除

      // 他の参加者に退出を通知
      debugLog(
        `[Server disconnect] Broadcasting 'user-left' to room ${roomCode}. Payload:`,
        { peerId }
      )
      // io.to(roomCode).emit('user-left', { peerId }) // { peerId } オブジェクトではなく peerId 文字列を送る方が一般的かも？クライアントの実装に合わせる
      io.to(roomCode).emit('user-left', peerId) // Peer ID 文字列を送信

      // ★ もし退出した人が画面共有中だったら、それも通知 ★
      if (wasSharing) {
        debugLog(
          `[Server disconnect] Broadcasting screen share stop because sharer ${peerId} left room ${roomCode}.`
        )
        room.sharerPeerId = null // 共有者IDをリセット
        // 部屋の全員に通知
        io.to(roomCode).emit('screen-share-status', {
          peerId: peerId, // 誰の共有が停止したか
          isSharing: false, // 停止したこと
          sharerPeerId: null, // 現在の共有者ID
        })
      }

      // 部屋に誰もいなくなったら部屋を削除
      if (Object.keys(room.participants).length === 0) {
        // ★ participants を確認
        debugLog(
          `[Server disconnect] Room ${roomCode} is empty, deleting room.`
        )
        delete rooms[roomCode]
      }
    } else {
      debugLog(
        `[Server disconnect] User ${socket.id} (Peer ID: ${peerId}) was not in a room or room data inconsistent.`
      )
    }
    debugLog(
      '[Server disconnect] Current rooms state AFTER delete:',
      JSON.stringify(rooms)
    )
  })

  debugLog(
    `[Server] Connection handler finished setting up listeners for socket ID: ${socket.id}`
  )
})
