import Peer, { MediaConnection, DataConnection } from 'peerjs'

// データ送受信用メッセージの型定義 (例)
type Message =
  | { type: 'USER_NAME'; payload: string }
  | { type: 'MUTE_STATUS'; payload: boolean }
  | { type: 'SCREEN_SHARE_STATUS'; payload: boolean }

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
  onReceiveScreenShareStatus?: (peerId: string, isSharing: boolean) => void // 相手の画面共有状態受信時
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

// +++ isMessage 型ガード関数 (変更なし) +++
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
  const potentialMessage = data as { type: unknown; payload: unknown }
  switch (potentialMessage.type) {
    case 'USER_NAME':
      return typeof potentialMessage.payload === 'string'
    case 'MUTE_STATUS':
      return typeof potentialMessage.payload === 'boolean'
    case 'SCREEN_SHARE_STATUS':
      return typeof potentialMessage.payload === 'boolean'
    default:
      return false // Unknown type
  }
}

class PeerManager {
  private peer: Peer | null = null
  private localStream: MediaStream | null = null
  private mediaConnections: { [id: string]: MediaConnection } = {}
  private dataConnections: { [id: string]: DataConnection } = {}
  private currentRoomCode = ''
  private options: Options | null = null
  private myName = ''
  private isMuted = false
  private audioAnalysisMap = new Map<string, AudioAnalysisData>()
  private speakingThreshold = 10
  // ★★★ 画面共有関連のプロパティ (変更なし) ★★★
  private screenStream: MediaStream | null = null
  private originalVideoTrack: MediaStreamTrack | null = null
  private screenShareTrackEndedListener: (() => void) | null = null

  // ピアの初期化 (変更なし)
  async initPeer(
    options: Options,
    myName: string,
    initialIsMuted: boolean = false
  ): Promise<string> {
    console.log('[PeerManager initPeer] Options set:', options)
    this.options = options
    this.currentRoomCode = options.roomCode
    this.myName = myName
    this.isMuted = initialIsMuted

    return new Promise<string>(async (resolve, reject) => {
      try {
        this.peer = new Peer()
        this.peer.on('open', async (id) => {
          console.log('PeerManager: Peer opened with ID:', id)
          try {
            await this.getLocalStream()
            options.onPeerOpen(id)
            resolve(id)
          } catch (streamError) {
            console.error(
              'PeerManager: Failed to get local stream on peer open:',
              streamError
            )
            reject(new Error('マイクへのアクセスに失敗しました。'))
          }
        })
        this.peer.on('connection', (dataConn) => {
          console.log(
            `PeerManager: Incoming data connection from ${dataConn.peer}`
          )
          this.setupDataConnectionHandlers(dataConn)
        })
        this.peer.on('call', async (call) => {
          console.log(`PeerManager: Incoming call from ${call.peer}`)
          try {
            if (!this.localStream) {
              await this.getLocalStream()
            }
            // ★★★ null チェックを修正 ★★★
            if (!this.localStream) {
              console.error(
                'PeerManager: Local stream is still null after attempting to get it.'
              )
              // 応答せずに切断するなどのエラー処理が必要な場合がある
              return
            }
            call.answer(this.localStream) // ★ localStream! を削除 (上のチェックで保証)
            call.on('stream', (remoteStream) => {
              console.log(`PeerManager: Received stream from ${call.peer}`)
              options.onReceiveStream(remoteStream, call.peer)
              this.startVolumeAnalysis(call.peer, remoteStream)
            })
            call.on('close', () => {
              console.log(`PeerManager: Call with ${call.peer} closed.`)
              this.handleDisconnect(call.peer)
            })
            call.on('error', (err) => {
              console.error(`PeerManager: Call error with ${call.peer}:`, err)
              this.handleDisconnect(call.peer)
            })
            this.mediaConnections[call.peer] = call
            console.log(
              `PeerManager: Media connection established with ${call.peer}`
            )
          } catch (err) {
            console.error('PeerManager: Error answering call:', err)
          }
        })
        this.peer.on('disconnected', () => {
          console.warn('PeerManager: Peer disconnected from server.')
        })
        this.peer.on('close', () => {
          console.log('PeerManager: Peer connection closed.')
        })
        this.peer.on('error', (err) => {
          console.error('PeerManager: PeerJS error:', err)
          if (err.type === 'peer-unavailable') {
            const unavailablePeerId = err.message.match(/peer\s(.*?)\s/)?.[1]
            if (unavailablePeerId) {
              console.warn(
                `PeerManager: Peer ${unavailablePeerId} is unavailable.`
              )
              this.handleDisconnect(unavailablePeerId)
            }
          } else if (err.type === 'network') {
            console.error(
              'PeerManager: Network error. Check connection to PeerJS server.'
            )
          }
        })
      } catch (err) {
        console.error('PeerManager: Failed to initialize PeerJS:', err)
        reject(err)
      }
    })
  }

  // ローカルメディアストリームを取得するヘルパー関数
  private async getLocalStream(deviceId?: string): Promise<MediaStream> {
    // ★★★ currentTrack 変数を使用するように修正 ★★★
    const currentTrack = this.localStream?.getAudioTracks()[0]
    if (
      this.localStream &&
      (!deviceId || currentTrack?.getSettings().deviceId === deviceId)
    ) {
      console.log('PeerManager: Returning cached local stream.')
      return this.localStream
    }

    this.localStream?.getTracks().forEach((track) => track.stop())
    this.localStream = null
    console.log('PeerManager: Stopped existing local stream.')

    try {
      console.log(
        `PeerManager: Requesting local media stream (getUserMedia) with deviceId: ${deviceId || 'default'}`
      )
      // ★★★ constraints の二重定義を削除 ★★★
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        // video: false
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      console.log('PeerManager: getUserMedia successful!')
      this.localStream = stream
      this.options?.onLocalStream(stream)
      console.log('PeerManager: Local media stream obtained and notified.')
      return stream
    } catch (err) {
      console.error('PeerManager: Failed to get local media stream:', err)
      if (err instanceof Error) {
        console.error(
          `PeerManager: getUserMedia Error name: ${err.name}, message: ${err.message}`
        )
      }
      throw err
    }
  }

  // データ接続のイベントハンドラを設定 (変更なし)
  private setupDataConnectionHandlers(dataConn: DataConnection) {
    dataConn.on('open', () => {
      console.log(`PeerManager: Data connection opened with ${dataConn.peer}`)
      this.dataConnections[dataConn.peer] = dataConn
      console.log(
        `[PeerManager onDataConnectionOpen] Sending USER_NAME. My name is: "${this.myName}" to ${dataConn.peer}`
      )
      this.sendMessage('USER_NAME', this.myName, dataConn.peer)
      console.log(
        `[PeerManager onDataConnectionOpen] Sending MUTE_STATUS. My status is: ${this.isMuted} to ${dataConn.peer}`
      )
      this.sendMessage('MUTE_STATUS', this.isMuted, dataConn.peer)
      if (this.screenStream) {
        console.log(
          `[PeerManager onDataConnectionOpen] Sending SCREEN_SHARE_STATUS: true to ${dataConn.peer}`
        )
        this.sendMessage('SCREEN_SHARE_STATUS', true, dataConn.peer)
      }
    })
    dataConn.on('data', (data) => {
      console.log(`PeerManager: Received data from ${dataConn.peer}:`, data)
      if (isMessage(data)) {
        if (this.options) {
          switch (data.type) {
            case 'USER_NAME':
              this.options.onReceiveUserName(dataConn.peer, data.payload)
              break
            case 'MUTE_STATUS':
              this.options.onReceiveMuteStatus(dataConn.peer, data.payload)
              break
            case 'SCREEN_SHARE_STATUS':
              this.options.onReceiveScreenShareStatus?.(
                dataConn.peer,
                data.payload
              )
              break
          }
        }
      } else {
        console.warn('PeerManager: Received unknown message type:', data)
      }
    })
    dataConn.on('close', () => {
      console.log(`PeerManager: Data connection with ${dataConn.peer} closed.`)
      this.handleDisconnect(dataConn.peer)
    })
    dataConn.on('error', (err) => {
      console.error(
        `PeerManager: Data connection error with ${dataConn.peer}:`,
        err
      )
      this.handleDisconnect(dataConn.peer)
    })
  }

  // メッセージを特定のピアまたは全員に送信 (変更なし)
  private sendMessage(
    type: Message['type'],
    payload: Message['payload'],
    targetId?: string
  ) {
    if (!this.peer) return
    const message = { type, payload } as Message
    try {
      if (targetId) {
        if (this.dataConnections[targetId]?.open) {
          console.log(`PeerManager: Sending ${type} to ${targetId}:`, payload)
          this.dataConnections[targetId].send(message)
        } else {
          console.warn(
            `PeerManager: Data connection to ${targetId} not open or doesn't exist.`
          )
        }
      } else {
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

  // ユーザー名を送信する関数 (変更なし)
  sendUserName(name: string) {
    this.myName = name
    this.sendMessage('USER_NAME', name)
  }

  // ミュート状態を送信する関数 (変更なし)
  sendMuteStatus(isMuted: boolean) {
    this.isMuted = isMuted
    this.sendMessage('MUTE_STATUS', isMuted)
  }

  // データ接続を確立するヘルパー関数 (変更なし)
  private async connectData(targetId: string): Promise<DataConnection | null> {
    if (!this.peer) {
      console.warn('PeerManager: Cannot connect data. Peer not initialized.')
      return null
    }
    if (this.dataConnections[targetId]?.open) {
      return this.dataConnections[targetId]
    }
    return new Promise((resolve) => {
      try {
        console.log(
          `PeerManager: Attempting to establish data connection with ${targetId}`
        )
        if (!this.peer) {
          // 再度チェック
          console.error(
            'PeerManager: Peer became null unexpectedly before connecting data.'
          )
          resolve(null)
          return
        }
        const dataConn = this.peer.connect(targetId)
        dataConn.on('open', () => {
          console.log(
            `PeerManager: Data connection opened with ${targetId} (on connectData)`
          )
          this.setupDataConnectionHandlers(dataConn) // ここでハンドラを設定
          resolve(dataConn)
        })
        dataConn.on('error', (err) => {
          console.error(
            `PeerManager: Failed to connect data to ${targetId}:`,
            err
          )
          delete this.dataConnections[targetId]
          resolve(null)
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

  // 他のピアに発信する関数 (変更なし)
  async callPeer(targetId: string) {
    console.log(`[PeerManager] callPeer START for ${targetId}.`)
    if (!this.peer || !this.options) {
      console.warn(
        `PeerManager: Cannot call peer ${targetId}. Peer not initialized or options missing.`
      )
      return
    }
    if (this.mediaConnections[targetId]) {
      console.log(
        `PeerManager: Already have media connection with ${targetId}.`
      )
      return
    }
    console.log(`PeerManager: Calling peer: ${targetId}`)
    try {
      await this.connectData(targetId)
      await this.getLocalStream()
      if (!this.peer || !this.localStream) {
        console.error(
          'PeerManager: Peer or local stream became unavailable before calling.'
        )
        return
      }
      const call = this.peer.call(targetId, this.localStream)
      call.on('stream', (remoteStream) => {
        console.log(`PeerManager: Received stream from ${targetId} (on call)`)
        this.options?.onReceiveStream(remoteStream, call.peer)
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
      this.mediaConnections[targetId] = call
      console.log(
        `PeerManager: Media connection established with ${targetId} (on call)`
      )
    } catch (err) {
      console.error(`PeerManager: Error calling peer ${targetId}:`, err)
      this.handleDisconnect(targetId)
    }
  }

  // ★★★ マイク切り替えメソッド (修正) ★★★
  async switchMicrophone(newDeviceId: string) {
    console.log(
      `PeerManager: Attempting to switch microphone to ${newDeviceId}`
    )
    if (!this.localStream) {
      console.warn(
        'PeerManager: Cannot switch microphone, local stream not available.'
      )
      await this.getLocalStream(newDeviceId)
      return
    }
    // ★★★ 現在のトラック取得とデバイスID比較を修正 ★★★
    const currentAudioTrack = this.localStream.getAudioTracks()[0]
    if (currentAudioTrack?.getSettings().deviceId === newDeviceId) {
      console.log('PeerManager: Selected microphone is already in use.')
      return
    }

    try {
      const newStream = await this.getLocalStream(newDeviceId)
      const newAudioTrack = newStream.getAudioTracks()[0]
      if (!newAudioTrack) throw new Error('Failed to get new audio track.')

      await this.replaceTrackForAllConnections(newAudioTrack, 'audio') // ★ ヘルパー関数呼び出し

      const currentMuteState = this.isMuted
      newAudioTrack.enabled = !currentMuteState
      console.log(
        `PeerManager: Applied mute state (${currentMuteState}) to new audio track.`
      )
      console.log('PeerManager: Microphone switched successfully.')
    } catch (error) {
      console.error('PeerManager: Failed to switch microphone:', error)
      throw error
    }
  }

  // ★★★ startScreenShare メソッド (修正) ★★★
  async startScreenShare() {
    if (this.screenStream) {
      console.warn('PeerManager: Screen sharing is already active.')
      return
    }
    let screenVideoTrack: MediaStreamTrack | undefined // ★ catch ブロック外で参照できるように宣言
    try {
      console.log(
        'PeerManager: Requesting screen share access (getDisplayMedia)...'
      )
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      })
      console.log('PeerManager: getDisplayMedia successful!')

      screenVideoTrack = this.screenStream.getVideoTracks()[0] // ★ 変数に代入
      if (!screenVideoTrack)
        throw new Error('Failed to get video track from screen stream.')

      this.originalVideoTrack = this.localStream?.getVideoTracks()[0] || null

      this.screenShareTrackEndedListener = () => {
        console.log('PeerManager: Screen share track ended (stopped by user).')
        this.stopScreenShare()
      }
      screenVideoTrack.addEventListener(
        'ended',
        this.screenShareTrackEndedListener
      )

      await this.replaceTrackForAllConnections(screenVideoTrack, 'video') // ★ ヘルパー関数呼び出し

      this.sendMessage('SCREEN_SHARE_STATUS', true)
      console.log('PeerManager: Screen sharing started and notified.')
    } catch (error) {
      console.error('PeerManager: Failed to start screen share:', error)
      // ★★★ エラー時のクリーンアップ修正 ★★★
      const tracksToStop = this.screenStream?.getTracks() // null にする前に取得
      tracksToStop?.forEach((track) => track.stop())
      this.screenStream = null // 先に null にする

      // ★ リスナー削除は try...catch の外で取得した screenVideoTrack を使う
      if (this.screenShareTrackEndedListener && screenVideoTrack) {
        try {
          // removeEventListener もエラーを出す可能性があるので try...catch
          screenVideoTrack.removeEventListener(
            'ended',
            this.screenShareTrackEndedListener
          )
        } catch (removeError) {
          console.error("Error removing 'ended' listener:", removeError)
        }
        this.screenShareTrackEndedListener = null
      }
      this.originalVideoTrack = null
      throw error
    }
  }

  // ★★★ stopScreenShare メソッド (修正) ★★★
  async stopScreenShare() {
    if (!this.screenStream) {
      return
    }
    console.log('PeerManager: Stopping screen share...')
    // ★ オプショナルチェイニングを追加 (より安全に)
    const screenVideoTrack = this.screenStream?.getVideoTracks()[0]

    if (this.screenShareTrackEndedListener && screenVideoTrack) {
      try {
        // removeEventListener もエラーを出す可能性
        screenVideoTrack.removeEventListener(
          'ended',
          this.screenShareTrackEndedListener
        )
      } catch (removeError) {
        console.error("Error removing 'ended' listener:", removeError)
      }
      this.screenShareTrackEndedListener = null
    }

    this.screenStream?.getTracks().forEach((track) => track.stop()) // ★ オプショナルチェイニング
    this.screenStream = null

    try {
      await this.replaceTrackForAllConnections(this.originalVideoTrack, 'video') // ★ ヘルパー関数呼び出し
      this.originalVideoTrack = null

      this.sendMessage('SCREEN_SHARE_STATUS', false)
      console.log('PeerManager: Screen sharing stopped and notified.')
    } catch (error) {
      console.error(
        'PeerManager: Error while replacing track after stopping screen share:',
        error
      )
    }
  }

  // ★★★ 全接続のトラックを置き換えるヘルパーメソッド (変更なし) ★★★
  private async replaceTrackForAllConnections(
    newTrack: MediaStreamTrack | null,
    kind: 'audio' | 'video'
  ) {
    console.log(
      `PeerManager: Replacing ${kind} track for all connections with track:`,
      newTrack
    )
    for (const peerId in this.mediaConnections) {
      const conn = this.mediaConnections[peerId]
      const peerConnection = conn.peerConnection as
        | RTCPeerConnection
        | undefined

      if (peerConnection) {
        const senders = peerConnection.getSenders()
        const sender = senders.find((s) => s.track?.kind === kind)

        if (sender) {
          console.log(
            `PeerManager: Replacing ${kind} track for connection with ${peerId}`
          )
          try {
            await sender.replaceTrack(newTrack)
          } catch (replaceError) {
            console.error(
              `PeerManager: Failed to replace ${kind} track for ${peerId}:`,
              replaceError
            )
          }
        } else if (newTrack) {
          console.log(
            `PeerManager: Adding ${kind} track for connection with ${peerId}`
          )
          try {
            if (this.localStream) {
              peerConnection.addTrack(newTrack, this.localStream)
            } else {
              console.error(
                `PeerManager: Cannot add ${kind} track, localStream is null.`
              )
            }
          } catch (addError) {
            console.error(
              `PeerManager: Failed to add ${kind} track for ${peerId}:`,
              addError
            )
          }
        } else {
          console.log(
            `PeerManager: No ${kind} sender found and no new track for ${peerId}`
          )
        }
      } else {
        console.warn(
          `PeerManager: RTCPeerConnection not found for MediaConnection with ${peerId}`
        )
      }
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
        // ★★★ analysisData が null でないことを確認 ★★★
        const currentAnalysisData = this.audioAnalysisMap.get(peerId)
        if (!currentAnalysisData) return // Map から削除された場合はループ停止

        currentAnalysisData.animationFrameId = requestAnimationFrame(analyse)

        // ★★★ analyser と dataArray も null チェック ★★★
        if (!currentAnalysisData.analyser || !currentAnalysisData.dataArray)
          return

        currentAnalysisData.analyser.getByteFrequencyData(
          currentAnalysisData.dataArray
        ) // 周波数データを取得

        // 簡単な音量計算 (例: 平均値)
        let sum = 0
        for (let i = 0; i < currentAnalysisData.dataArray.length; i++) {
          sum += currentAnalysisData.dataArray[i]
        }
        const average = sum / currentAnalysisData.dataArray.length

        // しきい値と比較して話者状態を判断
        const isSpeaking = average > this.speakingThreshold

        // console.log( // ログが多すぎる場合はコメントアウト
        //   `[PeerManager analyse] Peer: ${peerId}, Average: ${average.toFixed(2)}, Threshold: ${this.speakingThreshold}, IsSpeaking: ${isSpeaking}`
        // )

        // 状態が変化した場合のみコールバックを呼び出す
        if (isSpeaking !== currentAnalysisData.lastIsSpeaking) {
          console.log(
            `[PeerManager] Speaking status changed for ${peerId}: ${isSpeaking}`
          )
          currentAnalysisData.lastIsSpeaking = isSpeaking
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
      // エラー発生時は分析を停止する試み
      this.stopVolumeAnalysis(peerId)
    }
  }

  // ★★★ 音声分析を停止する関数 ★★★
  private stopVolumeAnalysis(peerId: string) {
    const analysisData = this.audioAnalysisMap.get(peerId)
    if (analysisData) {
      if (analysisData.animationFrameId !== null) {
        cancelAnimationFrame(analysisData.animationFrameId)
        analysisData.animationFrameId = null // ★ null に戻す
      }
      // source を切断 (必須ではないが念のため)
      try {
        analysisData.source?.disconnect() // ★ オプショナルチェイニング
      } catch {
        /* ignore */
      }
      // AudioContext を閉じる (重要！)
      analysisData.context
        ?.close() // ★ オプショナルチェイニング
        .then(() => {
          console.log(`PeerManager: Closed AudioContext for ${peerId}`)
        })
        .catch((e) =>
          console.error(
            `PeerManager: Error closing AudioContext for ${peerId}:`,
            e
          )
        )

      this.audioAnalysisMap.delete(peerId) // ★ Map から削除
      console.log(`PeerManager: Stopped audio analysis for ${peerId}`)

      // ★ 停止時に isSpeaking: false を通知 (任意だが推奨)
      if (this.options?.onSpeakingStatusChange) {
        this.options.onSpeakingStatusChange(peerId, false)
      }
    }
  }

  // 切断処理を共通化 (変更なし)
  private handleDisconnect(peerId: string) {
    if (!peerId) return
    console.log(`PeerManager: Handling disconnect for peer: ${peerId}`)
    this.stopVolumeAnalysis(peerId)
    if (this.mediaConnections[peerId]) {
      this.mediaConnections[peerId].close()
      delete this.mediaConnections[peerId]
      console.log(`PeerManager: Closed media connection with ${peerId}`)
    }
    if (this.dataConnections[peerId]) {
      this.dataConnections[peerId].close()
      delete this.dataConnections[peerId]
      console.log(`PeerManager: Closed data connection with ${peerId}`)
    }
    if (this.options) {
      this.options.onPeerDisconnect(peerId)
    }
  }

  // 全接続を切断する関数 (修正)
  disconnectAll() {
    console.log('PeerManager: Disconnecting all connections...')
    this.stopScreenShare() // ★ 画面共有停止
    this.audioAnalysisMap.forEach((_, peerId) => {
      this.stopVolumeAnalysis(peerId)
    })
    this.audioAnalysisMap.clear()
    Object.keys(this.mediaConnections).forEach(
      (peerId) => this.handleDisconnect(peerId) // handleDisconnect が内部で削除するのでこれでOK
    )
    Object.keys(this.dataConnections).forEach(
      (peerId) => this.handleDisconnect(peerId) // handleDisconnect が内部で削除するのでこれでOK
    )
    if (this.peer && !this.peer.destroyed) {
      this.peer.destroy()
    }
    this.peer = null
    this.localStream?.getTracks().forEach((track) => track.stop())
    this.localStream = null
    // ★★★ 状態リセットを修正 ★★★
    this.mediaConnections = {} // 空にする
    this.dataConnections = {} // 空にする
    this.currentRoomCode = ''
    this.options = null
    this.myName = ''
    // ★★★ 画面共有関連のリセットを修正 ★★★
    this.screenStream?.getTracks().forEach((track) => track.stop()) // 念のため
    this.screenStream = null
    this.originalVideoTrack = null
    this.screenShareTrackEndedListener = null
    console.log(
      'PeerManager: All connections disconnected and resources released.'
    )
  }
}

// PeerManager のインスタンスをエクスポート (変更なし)
const peerManagerInstance = new PeerManager()
export default peerManagerInstance

// 個別の関数もエクスポート (変更なし)
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
export const startScreenShare =
  peerManagerInstance.startScreenShare.bind(peerManagerInstance)
export const stopScreenShare =
  peerManagerInstance.stopScreenShare.bind(peerManagerInstance)
