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
  onSpeakingStatusChange?: (peerId: string, isSpeaking: boolean) => void // オプショナル (?) でも OK
}

// ★★★ 音声分析関連の型 ★★★
interface AudioAnalysisData {
  context: AudioContext
  analyser: AnalyserNode
  source: MediaStreamAudioSourceNode
  lastIsSpeaking: boolean
  animationFrameId: number | null
  dataArray: Uint8Array // 音量データ格納用
}

// +++ isMessage 型ガード関数をクラスの外に移動 (または private static メソッドにする) +++
function isMessage(data: unknown): data is Message {
  // Check if data is a non-null object
  if (typeof data !== 'object' || data === null) {
    return false
  }

  // Check if 'type' and 'payload' properties exist
  if (!('type' in data) || !('payload' in data)) {
    return false
  }

  // Check the type property and corresponding payload type
  // Cast 'data' carefully here to access 'type' and 'payload'
  const potentialMessage = data as { type: unknown; payload: unknown }

  switch (potentialMessage.type) {
    case 'USER_NAME':
      return typeof potentialMessage.payload === 'string'
    case 'MUTE_STATUS':
      return typeof potentialMessage.payload === 'boolean'
    default:
      return false // Unknown type
  }
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
  // ★★★ 音声分析リソースを管理する Map ★★★
  private audioAnalysisMap = new Map<string, AudioAnalysisData>()
  // ★★★ 音量検出のしきい値 (要調整) ★★★
  private speakingThreshold = 10 // 例: 0-255 の範囲で調整

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

    return new Promise<string>(async (resolve, reject) => {
      try {
        // Peer オブジェクトを作成 (ID は PeerJS サーバーが自動生成)
        this.peer = new Peer()

        // Peer がサーバーに接続し、ID が割り当てられたときのイベント
        this.peer.on('open', (id) => {
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
  private async getLocalStream(deviceId?: string): Promise<MediaStream> {
    if (
      this.localStream &&
      (!deviceId ||
        this.localStream.getAudioTracks()[0]?.getSettings().deviceId ===
          deviceId)
    ) {
      console.log('PeerManager: Returning cached local stream.') // ★ 追加
      return this.localStream
    }

    try {
      console.log(
        'PeerManager: Requesting local media stream (getUserMedia)...'
      ) // ★ 追加

      // ★★★ getUserMedia の audio 制約を修正 ★★★
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true, // deviceId があれば指定
        // video: false // 必要なら video も追加
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints)
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

      // 送信する直前の this.myName をログ出力
      console.log(
        `[PeerManager onDataConnectionOpen] Sending USER_NAME. My name is: "${this.myName}" to ${dataConn.peer}`
      )
      this.sendMessage('USER_NAME', this.myName, dataConn.peer)
      // 送信する直前の this.isMuted をログ出力
      console.log(
        `[PeerManager onDataConnectionOpen] Sending MUTE_STATUS. My status is: ${this.isMuted} to ${dataConn.peer}`
      )
      this.sendMessage('MUTE_STATUS', this.isMuted, dataConn.peer)
    })

    // データを受信したときのイベント
    dataConn.on('data', (data) => {
      console.log(`PeerManager: Received data from ${dataConn.peer}:`, data)
      // ★★★ isMessage 型ガード関数を使用 ★★★
      if (isMessage(data)) {
        //  チェック後は安全に Message 型として扱える
        if (this.options) {
          switch (
            data.type // data を直接使用可能
          ) {
            case 'USER_NAME':
              this.options.onReceiveUserName(dataConn.peer, data.payload)
              break
            case 'MUTE_STATUS':
              this.options.onReceiveMuteStatus(dataConn.peer, data.payload)
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
  // ★★★ payload の型を Message['payload'] に変更 ★★★
  private sendMessage(
    type: Message['type'],
    payload: Message['payload'],
    targetId?: string
  ) {
    if (!this.peer) return // Peer が初期化されていない場合は送信しない

    // 型安全のため、型とペイロードの組み合わせを保証する (キャストが必要になる場合がある)
    const message = { type, payload } as Message

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
    // ★★★ this.peer の null チェックを追加 ★★★
    if (!this.peer) {
      console.warn('PeerManager: Cannot connect data. Peer not initialized.')
      return null
    }
    // 既に接続が開いているか確認
    if (this.dataConnections[targetId]?.open) {
      return this.dataConnections[targetId]
    }

    return new Promise((resolve) => {
      try {
        console.log(
          `PeerManager: Attempting to establish data connection with ${targetId}`
        )
        if (!this.peer) {
          console.error(
            'PeerManager: Peer became null unexpectedly before connecting data.'
          )
          resolve(null) // または reject(new Error(...)) など適切なエラー処理
          return
        }
        const dataConn = this.peer.connect(targetId)
        dataConn.on('open', () => {
          console.log(
            `PeerManager: Data connection opened with ${targetId} (on connectData)`
          )
          // this.dataConnections[targetId] = dataConn; // setupDataConnectionHandlers 内で追加される
          this.setupDataConnectionHandlers(dataConn)
          resolve(dataConn)
        })
        dataConn.on('error', (err) => {
          console.error(
            `PeerManager: Failed to connect data to ${targetId}:`,
            err
          )
          delete this.dataConnections[targetId] // エラー時はリストから削除した方が良いかも
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

      // TypeScript のフロー解析を助けるため、または念のため再チェック
      if (!this.peer)
        if (!this.localStream) {
          console.error(
            'PeerManager: Peer became null unexpectedly before calling.'
          )
          return // もし null になっていたら処理中断
        }

      // メディア接続 (通話) を開始
      // ★★★ これで this.peer は null でないと TypeScript に伝わる ★★★
      const call = this.peer.call(targetId, this.localStream!)

      // イベントハンドラ設定
      call.on('stream', (remoteStream) => {
        console.log(`PeerManager: Received stream from ${targetId} (on call)`)
        // ここでも options が null でないことを確認 (最初のチェックで確認済みだが念のため)
        this.options?.onReceiveStream(remoteStream, call.peer)
        // ★★★ 発信時にも音声分析を開始 ★★★
        this.startVolumeAnalysis(call.peer, remoteStream)
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

  // ★★★ マイク切り替えメソッドを追加 ★★★
  async switchMicrophone(newDeviceId: string) {
    console.log(
      `PeerManager: Attempting to switch microphone to ${newDeviceId}`
    )
    if (!this.localStream) {
      console.warn(
        'PeerManager: Cannot switch microphone, local stream not available.'
      )
      // ストリームがない場合は新たに取得するだけでも良いかも
      await this.getLocalStream(newDeviceId)
      return // ストリーム取得後に replaceTrack は不要
    }

    // 現在のトラックのデバイスIDと比較
    const currentAudioTrack = this.localStream.getAudioTracks()[0]
    if (currentAudioTrack?.getSettings().deviceId === newDeviceId) {
      console.log('PeerManager: Selected microphone is already in use.')
      return // 同じデバイスなら何もしない
    }

    try {
      // 1. 新しいデバイスIDで新しいオーディオトラックを取得
      //    getLocalStream を再利用して新しいストリームを取得し、localStream を更新
      const newStream = await this.getLocalStream(newDeviceId)
      const newAudioTrack = newStream.getAudioTracks()[0]

      if (!newAudioTrack) {
        throw new Error(
          'Failed to get new audio track from the selected device.'
        )
      }

      // 2. 既存のすべての MediaConnection でトラックを置き換える
      for (const peerId in this.mediaConnections) {
        const conn = this.mediaConnections[peerId]
        // PeerJS の MediaConnection からネイティブの RTCPeerConnection を取得 (内部プロパティにアクセス)
        const peerConnection = conn.peerConnection as
          | RTCPeerConnection
          | undefined

        if (peerConnection) {
          // オーディオトラックを送信している Sender を探す
          const senders = peerConnection.getSenders()
          const audioSender = senders.find(
            (sender) => sender.track?.kind === 'audio'
          )

          if (audioSender) {
            console.log(
              `PeerManager: Replacing audio track for connection with ${peerId}`
            )
            await audioSender.replaceTrack(newAudioTrack)
          } else {
            console.warn(
              `PeerManager: Audio sender not found for connection with ${peerId}`
            )
          }
        } else {
          console.warn(
            `PeerManager: RTCPeerConnection not found for MediaConnection with ${peerId}`
          )
        }
      }

      // 3. (オプション) 自分のミュート状態などを新しいトラックに適用
      const currentMuteState = this.isMuted // PeerManager の isMuted 状態
      newAudioTrack.enabled = !currentMuteState
      console.log(
        `PeerManager: Applied mute state (${currentMuteState}) to new audio track.`
      )

      console.log('PeerManager: Microphone switched successfully.')
    } catch (error) {
      console.error('PeerManager: Failed to switch microphone:', error)
      // エラー発生時の処理 (例: 古いストリームに戻す、ユーザーに通知など)
      // 必要であれば、エラー前の localStream に戻す処理を追加
      throw error // エラーを呼び出し元に伝える
    }
  }

  // ★★★ 音声分析ループを開始する関数 ★★★
  private startVolumeAnalysis(peerId: string, stream: MediaStream) {
    // すでに分析中なら何もしない
    if (this.audioAnalysisMap.has(peerId)) {
      console.log(`PeerManager: Audio analysis already running for ${peerId}`)
      return
    }
    // オーディオトラックがなければ何もしない
    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) {
      console.warn(`PeerManager: No audio track found for ${peerId}`)
      return
    }

    try {
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 256 // データ量を減らす (32, 64, 128, 256, ...)
      analyser.smoothingTimeConstant = 0.3 // 平滑化 (0 ~ 1)

      source.connect(analyser)
      // analyser を destination に接続しない (音は CallScreen で再生されるため)

      const dataArray = new Uint8Array(analyser.frequencyBinCount)
      const analysisData: AudioAnalysisData = {
        context,
        analyser,
        source,
        lastIsSpeaking: false,
        animationFrameId: null,
        dataArray,
      }
      this.audioAnalysisMap.set(peerId, analysisData)

      const analyse = () => {
        // 再帰的に呼び出すために animationFrameId を更新
        analysisData.animationFrameId = requestAnimationFrame(analyse)

        analyser.getByteFrequencyData(dataArray) // 周波数データを取得

        // 簡単な音量計算 (例: 平均値)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i]
        }
        const average = sum / dataArray.length

        // しきい値と比較して話者状態を判断
        const isSpeaking = average > this.speakingThreshold

        console.log(
          `[PeerManager analyse] Peer: ${peerId}, Average: ${average.toFixed(2)}, Threshold: ${this.speakingThreshold}, IsSpeaking: ${isSpeaking}`
        )

        // 状態が変化した場合のみコールバックを呼び出す
        if (isSpeaking !== analysisData.lastIsSpeaking) {
          console.log(
            `[PeerManager] Speaking status changed for ${peerId}: ${isSpeaking}`
          )
          analysisData.lastIsSpeaking = isSpeaking
          if (this.options?.onSpeakingStatusChange) {
            this.options.onSpeakingStatusChange(peerId, isSpeaking)
          }
        }
      }
      // 分析ループを開始
      analyse()
      console.log(`PeerManager: Started audio analysis for ${peerId}`)
    } catch (error) {
      console.error(
        `PeerManager: Error starting audio analysis for ${peerId}:`,
        error
      )
    }
  }

  // ★★★ 音声分析を停止する関数 ★★★
  private stopVolumeAnalysis(peerId: string) {
    const analysisData = this.audioAnalysisMap.get(peerId)
    if (analysisData) {
      if (analysisData.animationFrameId !== null) {
        cancelAnimationFrame(analysisData.animationFrameId)
        analysisData.animationFrameId = null
      }
      // source を切断 (必須ではないが念のため)
      try {
        analysisData.source.disconnect()
      } catch {
        /* ignore */
      }
      // AudioContext を閉じる (重要！)
      analysisData.context
        .close()
        .then(() => {
          console.log(`PeerManager: Closed AudioContext for ${peerId}`)
        })
        .catch((e) =>
          console.error(
            `PeerManager: Error closing AudioContext for ${peerId}:`,
            e
          )
        )

      this.audioAnalysisMap.delete(peerId)
      console.log(`PeerManager: Stopped audio analysis for ${peerId}`)
    }
  }

  // 切断処理を共通化
  private handleDisconnect(peerId: string) {
    if (!peerId) return // peerId が無効なら何もしない
    console.log(`PeerManager: Handling disconnect for peer: ${peerId}`)

    // ★★★ 音声分析を停止 ★★★
    this.stopVolumeAnalysis(peerId)

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

    // ★★★ すべての音声分析を停止 ★★★
    this.audioAnalysisMap.forEach((_, peerId) => {
      this.stopVolumeAnalysis(peerId)
    })
    this.audioAnalysisMap.clear() // Map をクリア

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
export const switchMicrophone =
  peerManagerInstance.switchMicrophone.bind(peerManagerInstance)
