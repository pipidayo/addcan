import Peer, { MediaConnection, DataConnection } from 'peerjs'

// データ送受信用メッセージの型定義 (例)
type Message =
  | { type: 'USER_NAME'; payload: string }
  | { type: 'MUTE_STATUS'; payload: boolean }

// initPeer に渡すオプションの型
type Options = {
  roomCode: string
  onReceiveStream: (stream: MediaStream, peerId: string) => void // 相手のストリーム受信
  onPeerOpen: (id: string) => void // 自分の Peer がオープンした時
  onLocalStream: (stream: MediaStream) => void // 自分のローカルストリーム取得時
  onReceiveUserName: (peerId: string, name: string) => void // 相手の名前受信時
  onReceiveMuteStatus: (peerId: string, isMuted: boolean) => void // 相手のミュート状態受信時
  onPeerDisconnect: (peerId: string) => void // 相手が切断した時
}

class PeerManager {
  private peer: Peer | null = null
  private localStream: MediaStream | null = null
  private mediaConnections: { [id: string]: MediaConnection } = {} // MediaConnection を ID で管理
  private dataConnections: { [id: string]: DataConnection } = {} // DataConnection を ID で管理
  private currentRoomCode = ''
  private options: Options | null = null // オプションを保持
  private myName = '' // 自分の名前を保持 (sendUserName で使うため)
  private isMuted = false // ミュート状態を保持

  // ピアの初期化
  async initPeer(
    options: Options,
    myName: string,
    initialIsMuted: boolean = false
  ): Promise<string> {
    // myName を引数に追加
    // ★★★ ログ追加: options が設定されたことを確認 ★★★
    console.log('[PeerManager initPeer] Options set:', options) // this.options ではなく引数をログ
    this.options = options
    this.currentRoomCode = options.roomCode
    this.myName = myName // 名前を保持
    this.isMuted = initialIsMuted // 受け取った初期状態で内部状態を設定

    // ★★★ disconnectAll() の呼び出しを削除 ★★★
    // 既存の接続があれば切断
    // this.disconnectAll()← この行を削除またはコメントアウト

    return new Promise<string>(async (resolve, reject) => {
      try {
        // Peer オブジェクトを作成 (ID は PeerJS サーバーが自動生成)
        this.peer = new Peer()

        // Peer がサーバーに接続し、ID が割り当てられたときのイベント
        this.peer.on('open', (id) => {
          console.warn(
            '[PeerManager initPeer] Existing peer found and destroying it first.'
          )
          console.log('PeerManager: Peer opened with ID:', id)
          options.onPeerOpen(id) // 外部に自分の ID を通知
          resolve(id) // Promise を解決
        })

        // 他のピアからのデータ接続要求があったときのイベント
        this.peer.on('connection', (dataConn) => {
          console.log(
            `PeerManager: Incoming data connection from ${dataConn.peer}`
          )
          this.setupDataConnectionHandlers(dataConn) // データ接続のハンドラを設定
        })

        // 他のピアからのメディア接続 (通話) 要求があったときのイベント
        this.peer.on('call', async (call) => {
          console.log(`PeerManager: Incoming call from ${call.peer}`)
          try {
            // ローカルストリームがなければ取得
            if (!this.localStream) {
              await this.getLocalStream() // ローカルストリーム取得処理を呼び出し
            }

            // 自分のストリームで応答
            call.answer(this.localStream!)

            // 相手のストリームを受信したときのイベント
            call.on('stream', (remoteStream) => {
              console.log(`PeerManager: Received stream from ${call.peer}`)
              options.onReceiveStream(remoteStream, call.peer) // 外部にストリームと相手の ID を通知
            })

            // 通話が切断されたときのイベント
            call.on('close', () => {
              console.log(`PeerManager: Call with ${call.peer} closed.`)
              this.handleDisconnect(call.peer) // 切断処理
            })
            // 通話でエラーが発生したときのイベント
            call.on('error', (err) => {
              console.error(`PeerManager: Call error with ${call.peer}:`, err)
              this.handleDisconnect(call.peer) // エラー時も切断処理
            })

            // 接続を管理リストに追加
            this.mediaConnections[call.peer] = call
            console.log(
              `PeerManager: Media connection established with ${call.peer}`
            )
          } catch (err) {
            console.warn(
              '[PeerManager initPeer] Existing peer found and destroying it first.'
            )
            console.error('PeerManager: Error answering call:', err)
          }
        })

        // PeerJS サーバーから切断されたときのイベント
        this.peer.on('disconnected', () => {
          console.warn(
            'PeerManager: Peer disconnected from server. Attempting to reconnect...'
          )
          // 必要に応じて再接続処理を試みる
          // this.peer?.reconnect();
        })

        // Peer オブジェクトが破棄されたときのイベント
        this.peer.on('close', () => {
          console.log('PeerManager: Peer connection closed.')
          // 自分自身の Peer が閉じた場合、関連するリソースをクリーンアップ
          // this.handleDisconnect(this.peer?.id || ''); // disconnectAll で処理されるため不要かも
        })

        // PeerJS でエラーが発生したときのイベント
        this.peer.on('error', (err) => {
          console.error('PeerManager: PeerJS error:', err)
          // エラータイプに応じた処理
          if (err.type === 'peer-unavailable') {
            const unavailablePeerId = err.message.match(/peer\s(.*?)\s/)?.[1]
            if (unavailablePeerId) {
              console.warn(
                `PeerManager: Peer ${unavailablePeerId} is unavailable.`
              )
              this.handleDisconnect(unavailablePeerId) // 接続不可なら切断扱い
            }
          } else if (err.type === 'network') {
            console.error(
              'PeerManager: Network error. Check connection to PeerJS server.'
            )
          }
          // initPeer の Promise をリジェクトするかどうかはエラーの種類による
          // reject(err);
        })
      } catch (err) {
        console.error('PeerManager: Failed to initialize PeerJS:', err)
        reject(err) // 初期化失敗時は Promise をリジェクト
      }
    })
  }

  // ローカルメディアストリームを取得するヘルパー関数
  private async getLocalStream(): Promise<MediaStream> {
    if (this.localStream) {
      console.log('PeerManager: Returning cached local stream.') // ★ 追加
      return this.localStream
    }
    try {
      console.log(
        'PeerManager: Requesting local media stream (getUserMedia)...'
      ) // ★ 追加
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      console.log('PeerManager: getUserMedia successful!') // ★ 追加
      this.localStream = stream
      this.options?.onLocalStream(stream) // 外部にローカルストリームを通知
      console.log('PeerManager: Local media stream obtained and notified.') // ★ 追加
      return stream
    } catch (err) {
      console.error('PeerManager: Failed to get local media stream:', err)
      // ★ エラーの種類を特定するログを追加
      if (err instanceof Error) {
        console.error(
          `PeerManager: getUserMedia Error name: ${err.name}, message: ${err.message}`
        )
      }
      throw err // エラーを再スロー
    }
  }

  // データ接続のイベントハンドラを設定
  private setupDataConnectionHandlers(dataConn: DataConnection) {
    // データ接続が開いたときのイベント (ここでも自分の情報を送る)
    dataConn.on('open', () => {
      console.log(`PeerManager: Data connection opened with ${dataConn.peer}`)
      this.dataConnections[dataConn.peer] = dataConn // 開いたら管理リストに追加
      // 接続確立後に自分の名前とミュート状態を送信
      this.sendMessage('USER_NAME', this.myName, dataConn.peer)
      this.sendMessage('MUTE_STATUS', this.isMuted, dataConn.peer)
    })

    // +++ 型ガード関数を追加 (クラスの外、またはクラス内の private メソッドとして) +++
    function isMessage(data: unknown): data is Message {
      if (typeof data === 'object' && data === null) return false
      const msg = data as any // 一時的に any を使用してプロパティアクセス
      if (typeof msg.type !== 'string' || !('payload' in msg)) return false
      switch (msg.type) {
        case 'USER_NAME':
          return typeof msg.payload === 'string'
        case 'MUTE_STATUS':
          return typeof msg.payload === 'boolean'
        default:
          return false // 不明なタイプ
      }
    }

    // データを受信したときのイベント
    dataConn.on('data', (data) => {
      console.log(`PeerManager: Received data from ${dataConn.peer}:`, data)
      if (isMessage(data)) {
        //  型ガード関数でチェック
        const message = data // チェック後は安全に Message 型として扱える
        if (this.options) {
          switch (message.type) {
            case 'USER_NAME':
              this.options.onReceiveUserName(dataConn.peer, message.payload)
              break
            case 'MUTE_STATUS':
              this.options.onReceiveMuteStatus(dataConn.peer, message.payload)
              break
          }
        }
      } else {
        console.warn('PeerManager: Received unknown message type:', data)
      }
    })

    // データ接続が閉じたときのイベント
    dataConn.on('close', () => {
      console.log(`PeerManager: Data connection with ${dataConn.peer} closed.`)
      this.handleDisconnect(dataConn.peer) // 切断処理
    })
    // データ接続でエラーが発生したときのイベント
    dataConn.on('error', (err) => {
      console.error(
        `PeerManager: Data connection error with ${dataConn.peer}:`,
        err
      )
      this.handleDisconnect(dataConn.peer) // エラー時も切断処理
    })
  }

  // メッセージを特定のピアまたは全員に送信
  private sendMessage(type: Message['type'], payload: any, targetId?: string) {
    if (!this.peer) return // Peer が初期化されていない場合は送信しない

    const message: Message = { type, payload }
    try {
      if (targetId) {
        // 特定のピアに送信
        if (
          this.dataConnections[targetId] &&
          this.dataConnections[targetId].open
        ) {
          console.log(`PeerManager: Sending ${type} to ${targetId}:`, payload)
          this.dataConnections[targetId].send(message)
        } else {
          console.warn(
            `PeerManager: Data connection to ${targetId} not open or doesn't exist.`
          )
          // 接続がない場合は接続を試みる (オプション)
          // this.connectData(targetId).then(conn => conn?.send(message));
        }
      } else {
        // 全員に送信 (接続が開いているピアのみ)
        console.log(
          `PeerManager: Sending ${type} to all connected peers:`,
          payload
        )
        Object.values(this.dataConnections).forEach((conn) => {
          if (conn.open) {
            conn.send(message)
          }
        })
      }
    } catch (error) {
      console.error(`PeerManager: Error sending message ${type}:`, error)
    }
  }

  // ユーザー名を送信する関数 (外部から呼び出す用)
  sendUserName(name: string) {
    this.myName = name // 内部の名前も更新
    this.sendMessage('USER_NAME', name) // 全員に送信
  }

  // ミュート状態を送信する関数 (外部から呼び出す用)
  sendMuteStatus(isMuted: boolean) {
    this.isMuted = isMuted //  内部の isMuted プロパティも更新
    this.sendMessage('MUTE_STATUS', isMuted) // 全員に送信
  }

  // データ接続を確立するヘルパー関数 (必要に応じて)
  private async connectData(targetId: string): Promise<DataConnection | null> {
    if (!this.peer || this.dataConnections[targetId]?.open) {
      return this.dataConnections[targetId] || null
    }
    return new Promise((resolve) => {
      try {
        console.log(
          `PeerManager: Attempting to establish data connection with ${targetId}`
        )
        const dataConn = this.peer.connect(targetId)
        dataConn.on('open', () => {
          console.log(
            `PeerManager: Data connection opened with ${targetId} (on connectData)`
          )
          this.dataConnections[targetId] = dataConn
          this.setupDataConnectionHandlers(dataConn)
          resolve(dataConn)
        })
        dataConn.on('error', (err) => {
          console.error(
            `PeerManager: Failed to connect data to ${targetId}:`,
            err
          )
          resolve(null) // 接続失敗
        })
      } catch (error) {
        console.error(
          `PeerManager: Error during data connection attempt to ${targetId}:`,
          error
        )
        resolve(null)
      }
    })
  }

  // 他のピアに発信する関数
  async callPeer(targetId: string) {
    // ★★★ ログ追加 ★★★
    console.log(
      `[PeerManager] callPeer START for ${targetId}. this.peer:`,
      this.peer,
      'this.options:',
      this.options
    )

    // ★★★ ログ追加 ★★★
    console.log(
      `[PeerManager] Checking peer and options before call to ${targetId}`
    )
    if (!this.peer || !this.options) {
      // ★★★ この警告が出る前の this.peer と this.options を確認 ★★★
      console.warn(
        `PeerManager: Cannot call peer ${targetId}. Peer not initialized or options missing. Peer:`,
        this.peer,
        'Options:',
        this.options
      )

      console.warn(
        `PeerManager: Cannot call peer ${targetId}. Peer not initialized or options missing.`
      )
      return
    }
    // 既にメディア接続がある場合は発信しない
    if (this.mediaConnections[targetId]) {
      console.log(
        `PeerManager: Already have media connection with ${targetId}.`
      )
      return
    }

    console.log(`PeerManager: Calling peer: ${targetId}`)
    try {
      // データ接続も確立 (または接続試行)
      await this.connectData(targetId) // データ接続を先に試みる

      // ローカルストリームを取得 (まだなければ)
      await this.getLocalStream()

      // メディア接続 (通話) を開始
      const call = this.peer.call(targetId, this.localStream!)

      // イベントハンドラ設定
      call.on('stream', (remoteStream) => {
        console.log(`PeerManager: Received stream from ${targetId} (on call)`)
        this.options!.onReceiveStream(remoteStream, call.peer)
      })
      call.on('close', () => {
        console.log(`PeerManager: Call with ${targetId} closed (on call).`)
        this.handleDisconnect(targetId)
      })
      call.on('error', (err) => {
        console.error(
          `PeerManager: Call error with ${targetId} (on call):`,
          err
        )
        this.handleDisconnect(targetId)
      })

      // 接続を管理リストに追加
      this.mediaConnections[targetId] = call
      console.log(
        `PeerManager: Media connection established with ${targetId} (on call)`
      )
    } catch (err) {
      console.error(`PeerManager: Error calling peer ${targetId}:`, err)
      // エラーが発生した場合、関連する接続をクリーンアップする試み
      this.handleDisconnect(targetId)
    }
  }

  // 切断処理を共通化
  private handleDisconnect(peerId: string) {
    if (!peerId) return // peerId が無効なら何もしない
    console.log(`PeerManager: Handling disconnect for peer: ${peerId}`)

    // MediaConnection を閉じて削除
    if (this.mediaConnections[peerId]) {
      this.mediaConnections[peerId].close()
      delete this.mediaConnections[peerId]
      console.log(`PeerManager: Closed media connection with ${peerId}`)
    }
    // DataConnection を閉じて削除
    if (this.dataConnections[peerId]) {
      this.dataConnections[peerId].close()
      delete this.dataConnections[peerId]
      console.log(`PeerManager: Closed data connection with ${peerId}`)
    }

    // 外部に切断を通知
    if (this.options) {
      this.options.onPeerDisconnect(peerId)
    }
  }

  // 全接続を切断する関数
  disconnectAll() {
    console.log('PeerManager: Disconnecting all connections...')
    // すべての MediaConnection を閉じる
    Object.keys(this.mediaConnections).forEach((peerId) =>
      this.handleDisconnect(peerId)
    )
    // すべての DataConnection を閉じる (handleDisconnect で処理されるが念のため)
    Object.keys(this.dataConnections).forEach((peerId) =>
      this.handleDisconnect(peerId)
    )

    // Peer オブジェクトを破棄
    if (this.peer) {
      if (!this.peer.destroyed) {
        this.peer.destroy()
      }
      this.peer = null
    }
    // ローカルストリームを停止
    this.localStream?.getTracks().forEach((track) => track.stop())
    this.localStream = null
    // 状態をリセット
    this.mediaConnections = {}
    this.dataConnections = {}
    this.currentRoomCode = ''
    this.options = null
    this.myName = ''
    console.log(
      'PeerManager: All connections disconnected and resources released.'
    )
  }
}

// PeerManager のインスタンスをエクスポート (シングルトンパターン)
const peerManagerInstance = new PeerManager()
export default peerManagerInstance

// 個別の関数もエクスポート (既存のコードとの互換性のため、または好みで)
export const initPeer = peerManagerInstance.initPeer.bind(peerManagerInstance)
export const callPeer = peerManagerInstance.callPeer.bind(peerManagerInstance)
export const disconnectAll =
  peerManagerInstance.disconnectAll.bind(peerManagerInstance)
export const sendUserName =
  peerManagerInstance.sendUserName.bind(peerManagerInstance)
export const sendMuteStatus =
  peerManagerInstance.sendMuteStatus.bind(peerManagerInstance)
