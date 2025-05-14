// src/app/components/PeerManager/index.ts
import Peer, { MediaConnection, DataConnection, PeerJSOption } from 'peerjs'
import type { Socket } from 'socket.io-client'

// --- インターフェースと型定義 ---
type Message =
  | { type: 'USER_NAME'; payload: string }
  | { type: 'MUTE_STATUS'; payload: boolean }

export type InitPeerOptions = {
  roomCode: string // roomCode は PeerManager 内部では直接使わないかも
  socket: Socket
  onRemoteStream: (stream: MediaStream, peerId: string) => void
  onPeerOpen: (id: string) => void
  onLocalStream: (stream: MediaStream) => void
  onReceiveUserName: (peerId: string, name: string) => void
  onReceiveMuteStatus: (peerId: string, isMuted: boolean) => void
  onPeerDisconnect: (peerId: string) => void
  onSpeakingStatusChange?: (peerId: string, isSpeaking: boolean) => void
  onLocalScreenStreamUpdate?: (stream: MediaStream | null) => void
  onRemoteScreenStreamUpdate?: (stream: MediaStream, peerId: string) => void
}

type AudioAnalysisData = {
  context: AudioContext
  analyser: AnalyserNode
  source: MediaStreamAudioSourceNode
  lastIsSpeaking: boolean
  animationFrameId: number | null
  dataArray: Uint8Array
}

// ★ 音声ミキシング用リソースの型
type AudioMixingResources = {
  audioContext: AudioContext
  micSource: MediaStreamAudioSourceNode | null // ★ null許容に変更
  screenSource: MediaStreamAudioSourceNode | null // ★ null許容に変更
  destination: MediaStreamAudioDestinationNode
  mixedAudioTrack: MediaStreamTrack // 生成されたミックス音声トラック
}

// --- PeerManager クラス定義 ---
export class PeerManager {
  private peer: Peer | null = null
  private localStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  private screenShareTrackEndedListener: (() => void) | null = null
  private mediaConnections: { [id: string]: MediaConnection } = {}
  private dataConnections: { [id: string]: DataConnection } = {}
  private screenMediaConnections: { [id: string]: MediaConnection } = {}
  private options: InitPeerOptions | null = null // オプションを保持
  private myName = ''
  private isMuted = false
  private audioAnalysisMap = new Map<string, AudioAnalysisData>()
  private readonly speakingThreshold = 10
  private audioMixingResources: AudioMixingResources | null = null
  private isCurrentlyScreenSharing: boolean = false
  private socket: Socket | null = null
  private roomCode: string | null = null
  // ★ オリジナルのマイクトラックを保持 (getLocalStream で設定)
  private originalMicTrack: MediaStreamTrack | null = null
  // ★ 無音ダミートラックを保持
  private silentAudioTrack: MediaStreamTrack | null = null

  // --- 型ガード関数 ---
  private isMessage(data: unknown): data is Message {
    if (typeof data !== 'object' || data === null) return false
    if (!('type' in data) || !('payload' in data)) return false
    const potentialMessage = data as { type: unknown; payload: unknown }
    switch (potentialMessage.type) {
      case 'USER_NAME':
        return typeof potentialMessage.payload === 'string'
      case 'MUTE_STATUS':
        return typeof potentialMessage.payload === 'boolean'
      default:
        return false
    }
  }

  // ★★★ Canvasからダミー映像トラックを生成するヘルパー関数を追加 ★★★
  private createDummyVideoTrack(): MediaStreamTrack {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d')
    if (ctx) {
      // Optional: Draw something minimal if needed, e.g., a black pixel
      ctx.fillStyle = 'black'
      ctx.fillRect(0, 0, 1, 1)
    }
    // captureStream needs to be called on the canvas element
    const stream = canvas.captureStream(1) // Capture at 1 frame per second
    const track = stream.getVideoTracks()[0]
    if (!track) {
      // This should ideally not happen if captureStream is supported
      throw new Error('Failed to create dummy video track from canvas.')
    }
    track.enabled = false // Start disabled
    console.log(
      `[PeerManager instance ${this.peer?.id}] Created dummy video track: ${track.id}`
    )
    return track
  }

  // ★★★ 無音のダミー音声トラックを生成するヘルパー関数を追加 ★★★
  private createSilentAudioTrack(): MediaStreamTrack {
    const audioContext = new AudioContext()
    const oscillator = audioContext.createOscillator()
    const gainNode = audioContext.createGain()

    oscillator.connect(gainNode)
    gainNode.connect(audioContext.destination)
    gainNode.gain.value = 0 // 無音にする

    const stream = audioContext.createMediaStreamDestination().stream
    const track = stream.getAudioTracks()[0]
    console.log(
      `[PeerManager instance ${this.peer?.id}] Created silent audio track: ${track.id}`
    )
    return track
  }

  // --- 音声分析関連メソッド ---
  private startAudioAnalysis(peerId: string, stream: MediaStream) {
    if (this.audioAnalysisMap.has(peerId)) return
    const audioTracks = stream.getAudioTracks()
    if (audioTracks.length === 0) return

    try {
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.3
      source.connect(analyser)
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
        const currentAnalysisData = this.audioAnalysisMap.get(peerId)
        if (
          !currentAnalysisData?.analyser ||
          !currentAnalysisData?.dataArray ||
          currentAnalysisData.context.state !== 'running'
        ) {
          if (currentAnalysisData?.animationFrameId)
            cancelAnimationFrame(currentAnalysisData.animationFrameId)
          return
        }
        currentAnalysisData.animationFrameId = requestAnimationFrame(analyse)
        currentAnalysisData.analyser.getByteFrequencyData(
          currentAnalysisData.dataArray
        )
        let sum = 0
        for (let i = 0; i < currentAnalysisData.dataArray.length; i++)
          sum += currentAnalysisData.dataArray[i]
        const average = sum / currentAnalysisData.dataArray.length
        const isSpeaking = average > this.speakingThreshold

        if (isSpeaking !== currentAnalysisData.lastIsSpeaking) {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Speaking status changed for ${peerId}: ${isSpeaking}`
          )
          currentAnalysisData.lastIsSpeaking = isSpeaking
          this.options?.onSpeakingStatusChange?.(peerId, isSpeaking)
        }
      }
      analyse()
      console.log(
        `[PeerManager instance ${this.peer?.id}] Started audio analysis for ${peerId}`
      )
    } catch (error) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Error starting audio analysis for ${peerId}:`,
        error
      )
      this.stopAudioAnalysis(peerId)
    }
  }

  private stopAudioAnalysis(peerId: string) {
    const analysisData = this.audioAnalysisMap.get(peerId)
    if (analysisData) {
      if (analysisData.animationFrameId !== null)
        cancelAnimationFrame(analysisData.animationFrameId)
      try {
        analysisData.source?.disconnect()
      } catch {
        /* ignore */
      }
      analysisData.context
        ?.close()
        .catch((e) =>
          console.error(`Error closing AudioContext for ${peerId}:`, e)
        )
      this.audioAnalysisMap.delete(peerId)
      console.log(
        `[PeerManager instance ${this.peer?.id}] Stopped audio analysis for ${peerId}`
      )
      this.options?.onSpeakingStatusChange?.(peerId, false)
    }
  }

  private stopAllAudioAnalysis() {
    this.audioAnalysisMap.forEach((_, peerId) => this.stopAudioAnalysis(peerId))
    this.audioAnalysisMap.clear()
  }

  // --- 接続処理関連メソッド ---
  private setupDataConnectionHandlers(dataConn: DataConnection) {
    dataConn.on('open', () => {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Data connection opened with ${dataConn.peer}`
      )
      this.dataConnections[dataConn.peer] = dataConn
      this.sendMessage('USER_NAME', this.myName, dataConn.peer)
      this.sendMessage('MUTE_STATUS', this.isMuted, dataConn.peer)
    })
    dataConn.on('data', (data) => {
      console.log(
        `★★★ [PeerManager instance ${this.peer?.id}] 'data' event fired for connection with ${dataConn.peer}`
      )

      this.handleDataMessage(data, dataConn.peer) // handleDataMessage を呼び出す
    })

    dataConn.on('close', () => {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Data connection with ${dataConn.peer} closed.`
      )
      this.handleDisconnect(dataConn.peer)
    })
    dataConn.on('error', (err) => {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Data connection error with ${dataConn.peer}:`,
        err
      )
      this.handleDisconnect(dataConn.peer)
    })
  }

  private handleDataMessage(data: unknown, peerId: string) {
    // ★★★ 1箇所目: 関数の最初にログを追加 ★★★
    console.log(
      `★★★ [PeerManager instance ${this.peer?.id}] Raw data received from ${peerId}:`,
      data
    )

    // ★★★ 代わりに isMessage 型ガードを使用 ★★★
    if (!this.isMessage(data)) {
      console.warn(
        `[PeerManager instance ${this.peer?.id}] Received invalid or unknown message format from ${peerId}:`,
        data
      )
      return
    }
    // ★★★ 2箇所目: 型ガードの後にログを追加 ★★★
    console.log(
      `[PeerManager instance ${this.peer?.id}] Processing data message from ${peerId}. Type: ${data.type}`
    )

    switch (data.type) {
      case 'USER_NAME':
        if (typeof data.payload === 'string') {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Received USER_NAME from ${peerId}: ${data.payload}`
          )
          this.options?.onReceiveUserName?.(peerId, data.payload)
        } else {
          console.warn(
            `[PeerManager instance ${this.peer?.id}] Invalid USER_NAME payload from ${peerId}`
          )
        }
        break
      case 'MUTE_STATUS':
        if (typeof data.payload === 'boolean') {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Received MUTE_STATUS from ${peerId}: ${data.payload}`
          )
          this.options?.onReceiveMuteStatus?.(peerId, data.payload)
        } else {
          console.warn(
            `[PeerManager instance ${this.peer?.id}] Invalid MUTE_STATUS payload from ${peerId}`
          )
        }
        break
    }
  }

  // --- メディアストリーム関連メソッド ---

  private async getLocalStream(deviceId?: string): Promise<MediaStream> {
    const currentAudioTrack = this.localStream?.getAudioTracks()[0]
    //  ダミー映像トラックも存在するか確認
    const currentVideoTrack = this.localStream?.getVideoTracks()[0]
    // キャッシュチェック: 音声デバイスIDが変わらず、かつ映像トラックも存在すればキャッシュを返す
    if (
      this.localStream &&
      currentVideoTrack && // 映像トラックの存在も確認
      (!deviceId || currentAudioTrack?.getSettings().deviceId === deviceId)
    ) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Returning cached local stream.`
      )
      return this.localStream
    }

    // 既存ストリーム停止
    this.localStream?.getTracks().forEach((track) => track.stop())
    this.localStream = null
    this.originalMicTrack = null // ★ マイク変更時はリセット
    console.log(
      `[PeerManager instance ${this.peer?.id}] Stopped existing local stream.`
    )

    try {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Requesting local media stream (getUserMedia - audio only) with deviceId: ${deviceId || 'default'}`
      )
      //  音声のみ要求
      const constraints: MediaStreamConstraints = {
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
        // video: true, // ← 削除！ カメラは要求しない
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      console.log(
        `[PeerManager instance ${this.peer?.id}] getUserMedia successful (audio only)!`
      )

      // ★★★ ダミー映像トラックを生成して追加 ★★★
      try {
        const dummyVideoTrack = this.createDummyVideoTrack()
        stream.addTrack(dummyVideoTrack)
        console.log(
          `[PeerManager instance ${this.peer?.id}] Added dummy video track.`
        )
      } catch (dummyTrackError) {
        console.error(
          '[PeerManager instance] Failed to create or add dummy video track:',
          dummyTrackError
        )
        // ダミートラックがなくても続行するが、画面共有が失敗する可能性を警告
        console.warn(
          '[PeerManager instance] Proceeding without dummy video track. Screen share might fail.'
        )
      }

      this.localStream = stream
      //  onLocalStream には音声＋ダミー映像トラックを含むストリームを渡す
      this.options?.onLocalStream(stream)
      console.log(
        `[PeerManager instance ${this.peer?.id}] Local media stream obtained and notified.`
      )
      const audioTrack = stream.getAudioTracks()[0]
      if (audioTrack) {
        this.originalMicTrack = audioTrack // ★ オリジナルトラックを保持
        audioTrack.enabled = !this.isMuted
      }
      return stream
    } catch (err) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Failed to get local media stream:`,
        err
      )

      throw err // その他のエラー（マイク拒否など）は再スロー
    }
  }

  // --- メッセージ送信メソッド --
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
          console.log(
            `[PeerManager instance ${this.peer?.id}] Sending ${type} to ${targetId}:`,
            payload
          )
          this.dataConnections[targetId].send(message)
        } else {
          console.warn(
            `[PeerManager instance ${this.peer?.id}] Data connection to ${targetId} not open or doesn't exist.`
          )
        }
      } else {
        console.log(
          `[PeerManager instance ${this.peer?.id}] Sending ${type} to all connected peers:`,
          payload
        )
        Object.values(this.dataConnections).forEach((conn) => {
          if (conn.open) conn.send(message)
        })
      }
    } catch (error) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Error sending message ${type}:`,
        error
      )
    }
  }

  // --- 切断処理 ---
  // ★ handleDisconnect でも Set から削除する処理を追加 ★
  private handleDisconnect(peerId: string) {
    if (!peerId) return
    console.log(/* ... */)
    this.stopAudioAnalysis(peerId)

    // 音声接続のクリーンアップ
    if (this.mediaConnections[peerId]) {
      this.mediaConnections[peerId].close()
      delete this.mediaConnections[peerId]
      console.log(
        `[PeerManager instance ${this.peer?.id}] Closed media connection with ${peerId}`
      )
    }
    // データ接続のクリーンアップ
    if (this.dataConnections[peerId]) {
      this.dataConnections[peerId].close()
      delete this.dataConnections[peerId]
      console.log(
        `[PeerManager instance ${this.peer?.id}] Closed data connection with ${peerId}`
      )
    }
    //  画面共有接続のクリーンアップ
    if (this.screenMediaConnections[peerId]) {
      this.screenMediaConnections[peerId].close()
      delete this.screenMediaConnections[peerId]
      console.log(
        `[PeerManager instance ${this.peer?.id}] Closed screen media connection with ${peerId}`
      )
    }
    this.options?.onPeerDisconnect(peerId) // 参加者削除通知
  }

  // --- 公開メソッド ---

  public isScreenSharing(): boolean {
    return this.isCurrentlyScreenSharing
  }

  public async initPeer(
    options: InitPeerOptions,
    peerName: string,
    initialIsMuted: boolean = false
  ): Promise<string> {
    console.log('[PeerManager instance] initPeer called.')
    this.options = options
    this.myName = peerName
    this.isMuted = initialIsMuted
    this.socket = options.socket
    this.roomCode = options.roomCode

    if (this.peer) {
      console.error(
        '[PeerManager instance] initPeer called on an already initialized instance. Destroying previous peer.'
      )
      this.peer.destroy()
      this.peer = null
    }

    return new Promise<string>(async (resolve, reject) => {
      try {
        console.log('[PeerManager instance] Creating new Peer.')

        const peerJsOptions: PeerJSOption = {
          debug: 2,
        }
        this.peer = new Peer(peerJsOptions)

        this.peer.on('open', async (id) => {
          if (!this.peer || this.peer.destroyed) {
            console.warn(
              `[PeerManager instance] on 'open' called for ID ${id}, but instance peer is null or destroyed.`
            )
            return
          }
          console.log('[PeerManager instance] Peer opened with ID:', id)
          try {
            await this.getLocalStream()
            this.options?.onPeerOpen(id)
            resolve(id)
          } catch (streamError) {
            console.error(
              '[PeerManager instance] Failed to get local stream on peer open:',
              streamError
            )
            if (this.peer && !this.peer.destroyed) {
              this.peer.destroy()
              this.peer = null
            }
            reject(new Error('マイクへのアクセスに失敗しました。'))
          }
        })

        this.peer.on('connection', (dataConn) => {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Incoming data connection from ${dataConn.peer}`
          )
          this.setupDataConnectionHandlers(dataConn)
        })

        this.peer.on('call', async (call) => {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Incoming call from ${call.peer}, metadata:`,
            call.metadata
          )

          // ★ メタデータで画面共有か音声通話か判断
          if (call.metadata?.type === 'screenShare') {
            // --- 画面共有用の通話処理 ---
            console.log(
              `[PeerManager instance ${this.peer?.id}] Received screen share call from ${call.peer}`
            )
            call.answer() // 画面共有の受信側はストリームを送らない
            call.on('stream', (remoteScreenStream) => {
              console.log(
                `[PeerManager instance ${this.peer?.id}] Received screen stream from ${call.peer}`
              )
              // ★ onRemoteScreenStreamUpdate を呼び出す
              this.options?.onRemoteScreenStreamUpdate?.(
                remoteScreenStream,
                call.peer
              )
            })
            call.on('close', () => {
              console.log(
                `[PeerManager instance ${this.peer?.id}] Screen share call closed from ${call.peer}`
              )
              delete this.screenMediaConnections[call.peer]
            })
            call.on('error', (err) => {
              console.error(
                `[PeerManager instance ${this.peer?.id}] Screen share call error with ${call.peer}:`,
                err
              )
              delete this.screenMediaConnections[call.peer]
            })
            this.screenMediaConnections[call.peer] = call // 画面共有接続として保存
          } else {
            // --- 通常の音声通話処理 ---
            console.log(
              `[PeerManager instance ${this.peer?.id}] Received audio call from ${call.peer}`
            )

            try {
              if (!this.localStream) await this.getLocalStream() // 音声(+ダミー映像)ストリーム取得
              if (!this.localStream) {
                console.error(/* ... */)
                return
              }

              call.answer(this.localStream) // 音声(+ダミー映像)ストリームで応答
              call.on('stream', (remoteStream) => {
                console.log(
                  `[PeerManager instance ${this.peer?.id}] Received audio stream from ${call.peer} (on call answer)`
                )
                // ★ onRemoteStream を呼び出す
                this.options?.onRemoteStream(remoteStream, call.peer)
                this.startAudioAnalysis(call.peer, remoteStream)
              })

              call.on('close', () => this.handleDisconnect(call.peer))
              call.on('error', (err) => {
                console.error(
                  `[PeerManager instance ${this.peer?.id}] Audio call error with ${call.peer}:`,
                  err
                )
                this.handleDisconnect(call.peer)
              })
              this.mediaConnections[call.peer] = call // 音声接続として保存
            } catch (err) {
              console.error(
                `[PeerManager instance ${this.peer?.id}] Error answering audio call:`,
                err
              )
            }
          }
        })

        this.peer.on('disconnected', () =>
          console.warn(
            `[PeerManager instance ${this.peer?.id}] Peer disconnected from server.`
          )
        )
        this.peer.on('close', () => {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Peer connection closed.`
          )
          this.peer = null
        })
        this.peer.on('error', (err) => {
          console.error(
            `[PeerManager instance ${this.peer?.id}] PeerJS error:`,
            err
          )
          if (err.type === 'peer-unavailable') {
            const unavailablePeerId = err.message.match(/peer\s(.*?)\s/)?.[1]
            if (unavailablePeerId) this.handleDisconnect(unavailablePeerId)
          }
          if (
            ['server-error', 'socket-error', 'socket-closed'].includes(err.type)
          ) {
            if (this.peer && !this.peer.destroyed) {
              this.peer.destroy()
            }
            this.peer = null
          }
        })
      } catch (err) {
        console.error(
          '[PeerManager instance] Failed to initialize PeerJS:',
          err
        )
        if (this.peer && !this.peer.destroyed) {
          this.peer.destroy()
        }
        this.peer = null
        reject(err)
      }
    })
  }

  private async connectData(targetId: string): Promise<DataConnection | null> {
    if (!this.peer) return null
    if (this.dataConnections[targetId]?.open)
      return this.dataConnections[targetId]

    return new Promise((resolve) => {
      try {
        if (!this.peer) {
          resolve(null)
          return
        }
        console.log(
          `[PeerManager instance ${this.peer?.id}] Attempting to establish data connection with ${targetId}`
        )
        const dataConn = this.peer.connect(targetId)
        dataConn.on('open', () => {
          this.setupDataConnectionHandlers(dataConn)
          resolve(dataConn)
        })
        dataConn.on('error', (err) => {
          console.error(
            `[PeerManager instance ${this.peer?.id}] Data connection error with ${targetId}:`,
            err
          )
          delete this.dataConnections[targetId]
          resolve(null)
        })
      } catch (error) {
        console.error(
          `[PeerManager instance ${this.peer?.id}] Unexpected error in connectData for ${targetId}:`,
          error
        )
        resolve(null)
      }
    })
  }

  public async callPeer(targetId: string) {
    console.log(
      `[PeerManager instance ${this.peer?.id}] callPeer START for ${targetId}.`
    )
    if (!this.peer || !this.options) return
    if (this.mediaConnections[targetId]) return

    try {
      await this.connectData(targetId)
      if (!this.localStream) await this.getLocalStream()
      if (!this.peer || !this.localStream) return

      console.log(
        `[PeerManager instance ${this.peer?.id}] Calling peer: ${targetId}`
      )
      const call = this.peer.call(targetId, this.localStream)

      call.on('close', () => this.handleDisconnect(targetId))
      call.on('error', (err) => {
        console.error(
          `[PeerManager instance ${this.peer?.id}] Call error with ${targetId}:`,
          err
        )
        this.handleDisconnect(targetId)
      })
      this.mediaConnections[targetId] = call
    } catch (err) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Error calling peer ${targetId}:`,
        err
      )
      this.handleDisconnect(targetId)
    }
  }

  public sendUserName(name: string) {
    this.myName = name
    this.sendMessage('USER_NAME', name)
  }

  public async sendMuteStatus(muted: boolean) {
    this.isMuted = muted
    const newEnabledState = !this.isMuted
    console.log(
      `[PeerManager sendMuteStatus] Setting audio tracks enabled to: ${newEnabledState}`
    )

    const trackToSend = this.originalMicTrack // 常にオリジナルのマイク音声トラックを参照

    if (!trackToSend) {
      console.warn(
        '[PeerManager sendMuteStatus] No audio track available to send.'
      )
      return
    }

    // 1. originalMicTrack の enabled 状態を更新
    console.log(
      `[PeerManager sendMuteStatus] Updating originalMicTrack ${trackToSend.id} enabled to ${newEnabledState}`
    )
    trackToSend.enabled = newEnabledState

    // 2. localStream の音声トラックの enabled 状態を更新 (UI表示用)
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((localTrack) => {
        if (localTrack.id === trackToSend.id) {
          console.log(
            `[PeerManager sendMuteStatus] Updating localStream audio track ${localTrack.id} (same as originalMicTrack) enabled to ${newEnabledState}`
          )
          localTrack.enabled = newEnabledState
        } else {
          // localStream が originalMicTrack と異なるトラックを持っている場合 (通常は発生しないはず)
          // このケースは、localStream の再構築ロジックを見直す必要があるかもしれない
          console.warn(
            `[PeerManager sendMuteStatus] localStream audio track ${localTrack.id} differs from originalMicTrack ${trackToSend.id}. Setting enabled to ${newEnabledState}`
          )
          localTrack.enabled = newEnabledState
        }
      })
      this.options?.onLocalStream(this.localStream) // UIに通知
    }

    // 3. 各接続の RTCRtpSender が送信しているトラックの enabled を更新
    //    RTCRtpSender.track が this.originalMicTrack を指していることを前提とする
    const updateSenderTrackEnabled = (
      connections: { [id: string]: MediaConnection },
      connectionType: string
    ) => {
      Object.values(connections).forEach((conn) => {
        const pc = conn.peerConnection as RTCPeerConnection | undefined
        pc?.getSenders().forEach((sender) => {
          if (sender.track?.kind === 'audio') {
            if (sender.track.id === this.originalMicTrack?.id) {
              console.log(
                `[PeerManager sendMuteStatus] Updating ${connectionType} sender audio track ${sender.track.id} for peer ${conn.peer} enabled to ${newEnabledState}`
              )
              sender.track.enabled = newEnabledState
            } else {
              console.warn(
                `[PeerManager sendMuteStatus] ${connectionType} sender for peer ${conn.peer} is NOT using originalMicTrack. Sender track: ${sender.track.id}, Original: ${this.originalMicTrack?.id}`
              )
            }
          }
        })
      })
    }

    updateSenderTrackEnabled(this.mediaConnections, 'mediaConnection')
    if (this.isCurrentlyScreenSharing) {
      updateSenderTrackEnabled(
        this.screenMediaConnections,
        'screenMediaConnection'
      )
    }

    // 4. ミキシングリソース内のトラックも更新 (ミキシング有効時)
    //    (現在はミキシング無効化デバッグ中のため影響なし)
    if (
      this.audioMixingResources?.mixedAudioTrack &&
      this.audioMixingResources.mixedAudioTrack.readyState === 'live'
    ) {
      // ミキシングを再実装する場合は、ここでミキサーの入力を切り替えるロジックが必要
      // 現在はミキシング無効化デバッグ中のため、ここには到達しない想定
      console.log(
        `[PeerManager sendMuteStatus] Updating mixedAudioTrack ${this.audioMixingResources.mixedAudioTrack.id} enabled to ${newEnabledState}`
      )
      this.audioMixingResources.mixedAudioTrack.enabled = newEnabledState
    }

    // 5. 相手にミュート状態を通知
    this.sendMessage('MUTE_STATUS', this.isMuted)
  }

  // replaceTrackForAllConnections メソッドを汎用化し、接続リストを引数で受け取る
  private async replaceTrackForAllConnections(
    newTrack: MediaStreamTrack | null,
    kind: 'audio',
    connections: { [id: string]: MediaConnection } // 接続リストを引数で受け取る
  ) {
    // このメソッドは主に音声トラックの置換に使われる想定
    console.log(
      `[PeerManager instance ${this.peer?.id}] Replacing ${kind} track for connections. New track info: id=${newTrack?.id}, kind=${newTrack?.kind}, readyState=${newTrack?.readyState}`
    )
    const peerIds = Object.keys(connections)
    console.log(
      `[PeerManager replaceTrackForAllConnections] Active connections to process: ${peerIds.length}`
    )

    if (peerIds.length === 0) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] No connections to replace track on.`
      )
      return
    }
    const replacePromises: Promise<void>[] = []

    for (const peerId in connections) {
      const conn = connections[peerId]
      const peerConnection = conn.peerConnection as
        | RTCPeerConnection
        | undefined

      if (peerConnection) {
        const sender = peerConnection
          .getSenders()
          .find((s) => s.track?.kind === kind)
        if (sender) {
          console.log(
            `[PeerManager replaceTrackForAllConnections] Found sender for ${kind} track for connection with ${peerId}. Current track ID: ${sender.track?.id ?? 'null'}, Current track State: ${sender.track?.readyState ?? 'N/A'}`
          )
          replacePromises.push(
            (async () => {
              try {
                console.log(
                  `[PeerManager instance ${this.peer?.id}] Attempting sender.replaceTrack() for ${peerId}...`
                )
                if (newTrack && newTrack.readyState !== 'live') {
                  console.warn(
                    `[PeerManager replaceTrackForAllConnections] WARNING: Attempting to replace with a non-live track (ID: ${newTrack.id}, State: ${newTrack.readyState}) for ${peerId}.`
                  )
                }
                await sender.replaceTrack(newTrack)
                // ★ replaceTrack後、新しいトラックのenabled状態を現在のミュート状態に合わせる
                if (newTrack) {
                  newTrack.enabled = !this.isMuted
                  console.log(
                    `[PeerManager replaceTrackForAllConnections] Set new track ${newTrack.id} for ${peerId} enabled to ${newTrack.enabled} (isMuted: ${this.isMuted})`
                  )
                }
                console.log(
                  `[PeerManager replaceTrackForAllConnections] Successfully replaced ${kind} track for ${peerId}. New sender track ID: ${sender.track?.id ?? 'null'}`
                )
                // ★★★ replaceTrack 後の接続状態を確認 ★★★
                console.log(
                  `[PeerManager replaceTrackForAllConnections] PeerConnection state for ${peerId} after replaceTrack: signalingState=${peerConnection.signalingState}, connectionState=${peerConnection.connectionState}, iceConnectionState=${peerConnection.iceConnectionState}`
                )
              } catch (replaceError) {
                console.error(
                  `[PeerManager instance ${this.peer?.id}] Failed to replace ${kind} track for ${peerId}:`,
                  replaceError,
                  replaceError instanceof Error ? replaceError.name : '',
                  replaceError instanceof Error ? replaceError.message : ''
                )
              }
            })()
          )
        } else {
          console.warn(
            `[PeerManager replaceTrackForAllConnections] Could not find sender for ${kind} track for ${peerId}.`
          )
        }
      } else {
        console.warn(
          `[PeerManager replaceTrackForAllConnections] No peerConnection found for connection with ${peerId}.`
        )
      }
    }
    await Promise.all(replacePromises)
  }

  public async switchMicrophone(newDeviceId: string) {
    console.log(
      `[PeerManager instance ${this.peer?.id}] Attempting to switch microphone to ${newDeviceId}`
    )
    const currentAudioTrack = this.localStream?.getAudioTracks()[0]
    if (currentAudioTrack?.getSettings().deviceId === newDeviceId) return

    const oldLocalAudioTrack = this.localStream?.getAudioTracks()[0]
    console.log(
      `[PeerManager switchMicrophone] Old local audio track ID: ${oldLocalAudioTrack?.id}, State: ${oldLocalAudioTrack?.readyState}`
    )

    try {
      console.log(
        `[PeerManager switchMicrophone] Requesting new audio track for deviceId: ${newDeviceId}`
      )
      const newMicStream = await navigator.mediaDevices.getUserMedia({
        audio: newDeviceId ? { deviceId: { exact: newDeviceId } } : true,
      })
      const newAudioTrack = newMicStream.getAudioTracks()[0]
      this.originalMicTrack = newAudioTrack // ★ 新しいオリジナルトラックを保持

      if (!newAudioTrack) {
        console.error(
          `[PeerManager switchMicrophone] Failed to get new audio track from newMicStream for deviceId: ${newDeviceId}.`
        )
        newMicStream.getTracks().forEach((track) => track.stop())
        throw new Error('Failed to get new audio track.')
      }
      if (newAudioTrack.readyState !== 'live') {
        console.warn(
          `[PeerManager switchMicrophone] New audio track (ID: ${newAudioTrack.id}) for mic switch is not live. State: ${newAudioTrack.readyState}. Aborting switch.`
        )
        newAudioTrack.stop()
        newMicStream.getTracks().forEach((track) => track.stop())
        throw new Error(
          `New audio track is not live: ${newAudioTrack.readyState}`
        )
      }

      console.log(
        `[PeerManager switchMicrophone] Successfully obtained new audio track: ID=${newAudioTrack.id}, State=${newAudioTrack.readyState}`
      )

      await this.replaceTrackForAllConnections(
        newAudioTrack,
        'audio',
        this.mediaConnections
      )
      // newAudioTrack.enabled は replaceTrackForAllConnections 内で設定される

      if (
        this.isCurrentlyScreenSharing &&
        newAudioTrack.readyState === 'live'
      ) {
        console.log(
          `[PeerManager switchMicrophone] Screen sharing is active. Replacing track for screen share connections with new mic track ID: ${newAudioTrack.id}`
        )
        // ★★★ screenMediaConnections のトラックも新しい originalMicTrack に置き換える ★★★
        await this.replaceTrackForAllConnections(
          newAudioTrack, // 新しい originalMicTrack
          'audio',
          this.screenMediaConnections
        )
        // newAudioTrack.enabled は replaceTrackForAllConnections 内で設定される (はずだったが、enabled の設定は sendMuteStatus に集約)
        newAudioTrack.enabled = !this.isMuted // ここで明示的に設定
        console.log(
          `[PeerManager switchMicrophone] Screen share connections updated with new mic track ${newAudioTrack.id}. Enabled: ${newAudioTrack.enabled}`
        )
      }

      // ★★★ デバッグのため、クローンではなくオリジナルの newAudioTrack を localStream に使用 ★★★
      const trackForLocalStream = newAudioTrack
      console.log(
        `[PeerManager switchMicrophone DEBUG] Using original newAudioTrack for localStream (clone disabled for debug). ID=${trackForLocalStream.id}`
      )
      trackForLocalStream.enabled = !this.isMuted
      console.log(
        `[PeerManager switchMicrophone] Before reconstructing localStream. trackForLocalStream ID: ${trackForLocalStream.id}, State: ${trackForLocalStream.readyState}, Enabled: ${trackForLocalStream.enabled}`
      )

      const dummyVideoTrack = this.localStream?.getVideoTracks()[0]
      const newLocalStreamTracks: MediaStreamTrack[] = [trackForLocalStream]
      if (dummyVideoTrack && dummyVideoTrack.readyState === 'live') {
        newLocalStreamTracks.push(dummyVideoTrack)
      } else {
        console.warn(
          `[PeerManager switchMicrophone] Dummy video track not found or not live. Re-creating for localStream.`
        )
        try {
          const newDummyVideoTrack = this.createDummyVideoTrack()
          newLocalStreamTracks.push(newDummyVideoTrack)
        } catch (e) {
          console.error(
            '[PeerManager switchMicrophone] Failed to create new dummy video track for localStream',
            e
          )
        }
      }
      this.localStream = new MediaStream(newLocalStreamTracks)
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted
        console.log(
          `[PeerManager switchMicrophone] Set new localStream audio track ${track.id} (isMuted: ${this.isMuted}) enabled to ${track.enabled}`
        )
      })
      this.options?.onLocalStream(this.localStream)

      console.log(
        `[PeerManager switchMicrophone] Microphone switched successfully to device ID: ${newDeviceId}. Final localStream audio track ID: ${trackForLocalStream.id}`
      )

      if (
        oldLocalAudioTrack &&
        oldLocalAudioTrack.id !== newAudioTrack.id &&
        oldLocalAudioTrack.readyState === 'live'
      ) {
        // console.log(
        //   `[PeerManager switchMicrophone] (DEBUG) Intentionally NOT stopping old local audio track: ID=${oldLocalAudioTrack.id}, State=${oldLocalAudioTrack.readyState}`
        // );
        // oldLocalAudioTrack.stop(); // ★★★ この行を一時的にコメントアウト ★★★
      }
    } catch (error) {
      console.error(
        `[PeerManager switchMicrophone] Failed to switch microphone:`,
        error
      )
      throw error
    }
  }

  public async startScreenShareToPeer(peerId: string): Promise<void> {
    if (!this.peer || !this.isCurrentlyScreenSharing) {
      console.warn(
        `[PeerManager] Cannot start screen share to peer ${peerId}: Not ready or not sharing.`
      )
      return
    }
    if (this.screenMediaConnections[peerId]) {
      console.log(
        `[PeerManager] Screen share connection to ${peerId} already exists.`
      )
      return
    }

    const streamToShare = new MediaStream()
    const screenVideoTrack = this.screenStream?.getVideoTracks()[0]
    // ★★★ デバッグのため、ミキシング無効化＆オリジナルトラックを使用 ★★★
    const audioTrackToShare = this.originalMicTrack // 画面共有にはオリジナルのマイク音声を使用

    if (!screenVideoTrack) {
      console.error(
        `[PeerManager] Cannot start screen share to peer ${peerId}: Screen video track unavailable.`
      )
      return
    }
    streamToShare.addTrack(screenVideoTrack)
    if (audioTrackToShare) {
      // ★★★ デバッグのため、オリジナルトラックをそのまま追加 (クローンしない) ★★★
      streamToShare.addTrack(audioTrackToShare)
      console.log(
        `[PeerManager] Preparing screen share stream for ${peerId} with video and audio (using original mic track for debug).`
      )
    } else {
      console.log(
        `[PeerManager] Preparing screen share stream for ${peerId} with video only (original mic track unavailable).`
      )
    }

    console.log(
      `[PeerManager instance ${this.peer.id}] Calling ${peerId} for screen share (new peer)...`
    )
    try {
      const screenCall = this.peer.call(peerId, streamToShare, {
        metadata: { type: 'screenShare' },
      })
      if (!screenCall) {
        throw new Error('Failed to initiate screen share call.')
      }

      screenCall.on('close', () => {
        console.log(
          `[PeerManager instance ${this.peer?.id}] Screen share call closed with ${peerId} (initiated side).`
        )
        delete this.screenMediaConnections[peerId]
      })
      screenCall.on('error', (err) => {
        console.error(
          `[PeerManager instance ${this.peer?.id}] Screen share call error with ${peerId} (initiated side):`,
          err
        )
        delete this.screenMediaConnections[peerId]
      })

      this.screenMediaConnections[peerId] = screenCall
      console.log(
        `[PeerManager] Screen share call initiated to new peer ${peerId}`
      )
    } catch (error) {
      console.error(
        `[PeerManager] Error starting screen share call to new peer ${peerId}:`,
        error
      )
    }
  }

  public async startScreenShare() {
    if (this.isCurrentlyScreenSharing) {
      console.warn('[PeerManager] Screen share already active.')
      return
    }
    this.cleanupAudioMixingResources()

    console.log('[PeerManager] Starting screen share (Separate Call Method)...')
    let screenVideoTrack: MediaStreamTrack | null = null
    let audioTrackForScreenShare: MediaStreamTrack | null = null // 変数名を変更

    console.log(
      '[PeerManager startScreenShare] Temporarily disabling audio on mediaConnections.'
    )
    Object.values(this.mediaConnections).forEach((conn) => {
      const pc = conn.peerConnection as RTCPeerConnection | undefined
      pc?.getSenders().forEach((sender) => {
        if (sender.track?.kind === 'audio') {
          console.log(
            `[PeerManager startScreenShare] Checking mediaConnection audio track ${sender.track.id} for peer ${conn.peer}. Current localStream track ID: ${this.localStream?.getAudioTracks()[0]?.id}`
          )
          console.log(
            `[PeerManager startScreenShare] Disabling audio track ${sender.track.id} for mediaConnection with ${conn.peer}`
          )
          sender.track.enabled = false
        }
      })
    })

    try {
      if (!this.localStream) {
        await this.getLocalStream()
      }
      // ★★★ デバッグのため、画面共有にはオリジナルのマイク音声を使用 ★★★
      audioTrackForScreenShare = this.originalMicTrack
      if (!audioTrackForScreenShare) {
        console.warn(
          '[PeerManager startScreenShare] Original microphone audio track is unavailable for screen share.'
        )
      } else {
        console.log(
          '[PeerManager] Using original microphone audio track for screen share:',
          audioTrackForScreenShare.id
        )
      }

      console.log(
        '[PeerManager] Requesting screen share stream (VIDEO + AUDIO)'
      )
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        })
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'NotAllowedError') {
          console.log('[PeerManager] Screen share cancelled by user.')
          this.cleanupScreenShareResources()
          if (this.socket && this.socket.connected) {
            console.log(
              '[PeerManager] Notifying server of screen share cancellation (emit notify-stop-share).'
            )
            this.socket.emit('notify-stop-share')
          } else {
            console.warn(
              '[PeerManager] Socket not available or not connected, cannot notify server of cancellation.'
            )
          }
          return
        } else {
          console.error('[PeerManager] Error getting display media:', err)
          throw err
        }
      }

      screenVideoTrack = this.screenStream.getVideoTracks()[0]
      const screenAudioTrack = this.screenStream.getAudioTracks()[0]

      if (!screenVideoTrack) {
        throw new Error('No video track found in screen share stream.')
      }
      console.log('[PeerManager] Screen share stream obtained.')
      if (screenAudioTrack) {
        console.log(
          '[PeerManager] Screen share stream includes audio track:',
          screenAudioTrack.id
        )
      } else {
        console.log(
          '[PeerManager] Screen share stream does NOT include audio track.'
        )
      }

      // ★★★ デバッグのためミキシング処理は完全にスキップ ★★★
      // audioTrackForScreenShare は既に this.originalMicTrack を指している
      if (audioTrackForScreenShare) {
        console.log(
          `[PeerManager startScreenShare] Using originalMicTrack ${audioTrackForScreenShare.id} for screen share.`
        )
        // ★★★ screenMediaConnections で送信するトラックの enabled を現在のミュート状態に合わせる ★★★
        // (この時点では originalMicTrack は既にミュート状態を反映しているはずだが念のため)
        audioTrackForScreenShare.enabled = !this.isMuted // isMuted は PeerManager のプロパティ

        console.log(
          `[PeerManager startScreenShare DEBUG] Set original micAudioTrack for screen share enabled to ${audioTrackForScreenShare.enabled} (isMuted: ${this.isMuted})`
        )
      } else {
        console.warn(
          '[PeerManager startScreenShare DEBUG] No original mic audio track available for screen share.'
        )
      }

      this.isCurrentlyScreenSharing = true

      this.screenShareTrackEndedListener = () => {
        console.log(
          `[PeerManager instance ${this.peer?.id}] Screen share track ended listener triggered.`
        )
        this.stopScreenShare()
      }
      if (!screenVideoTrack) {
        throw new Error(
          "Screen video track is unexpectedly null before adding 'ended' listener."
        )
      }
      screenVideoTrack.addEventListener(
        'ended',
        this.screenShareTrackEndedListener
      )

      const connectedPeerIds = Object.keys(this.dataConnections)
      console.log(
        `[PeerManager instance ${this.peer?.id}] Starting screen share calls to existing peers (DataConnections):`,
        connectedPeerIds
      )

      await Promise.all(
        connectedPeerIds.map((peerId) => this.startScreenShareToPeer(peerId))
      )

      console.log(
        '[PeerManager startScreenShare] Calling onLocalScreenStreamUpdate callback...',
        this.options?.onLocalScreenStreamUpdate
          ? 'Callback exists'
          : 'Callback missing'
      )
      this.options?.onLocalScreenStreamUpdate?.(this.screenStream)

      console.log(
        `[PeerManager instance ${this.peer?.id}] Screen sharing initiated (Separate Call Method, NO Audio Mixing, original mic track for debug).`
      )
    } catch (error) {
      console.error('[PeerManager] Error starting screen share:', error)
      this.cleanupScreenShareResources()
      throw error
    }
  }

  public async stopScreenShare() {
    console.log(
      `[PeerManager instance ${this.peer?.id}] Attempting to stop screen share.`
    )
    if (!this.isCurrentlyScreenSharing) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Screen sharing is not active.`
      )
      return
    }

    this.isCurrentlyScreenSharing = false
    this.cleanupScreenShareResources()

    console.log(
      `[PeerManager instance ${this.peer?.id}] Closing all screen share connections.`
    )
    Object.values(this.screenMediaConnections).forEach((conn) => conn.close())
    this.screenMediaConnections = {}

    if (this.socket && this.peer?.id && this.roomCode) {
      console.log('[PeerManager] Notifying server of stop share...')
      this.socket.emit('notify-stop-share')
    } else {
      console.warn(
        '[PeerManager stopScreenShare] Socket/PeerID/RoomCode missing, could not notify server.'
      )
    }

    const currentMicTrack = this.localStream?.getAudioTracks()[0] // これはマイク変更後のトラック (オリジナルのはず)
    if (currentMicTrack && currentMicTrack.readyState === 'live') {
      console.log(
        '[PeerManager stopScreenShare] Re-enabling audio on mediaConnections if applicable.'
      )
      Object.values(this.mediaConnections).forEach((conn) => {
        const pc = conn.peerConnection as RTCPeerConnection | undefined
        pc?.getSenders().forEach((sender) => {
          if (sender.track?.kind === 'audio') {
            console.log(
              `[PeerManager stopScreenShare] Ensuring audio track ${sender.track.id} for mediaConnection with ${conn.peer} is set to enabled: ${!this.isMuted}`
            )
            sender.track.enabled = !this.isMuted
          }
        })
      })

      console.log(
        `[PeerManager stopScreenShare] Re-applying current mic track (ID: ${currentMicTrack.id}, State: ${currentMicTrack.readyState}) to mediaConnections.`
      )
      await this.replaceTrackForAllConnections(
        currentMicTrack,
        'audio',
        this.mediaConnections
      )
      // currentMicTrack.enabled は replaceTrackForAllConnections 内で設定される
    } else {
      console.warn(
        `[PeerManager stopScreenShare] Current mic track is not available or not live after stopping screen share. ID: ${currentMicTrack?.id}, State: ${currentMicTrack?.readyState}. Voice might not be sent on mediaConnections.`
      )
    }

    console.log(
      `[PeerManager instance ${this.peer?.id}] Screen sharing stopped.`
    )
  }

  private cleanupAudioMixingResources() {
    if (this.audioMixingResources) {
      console.log('[PeerManager] Cleaning up audio mixing resources...')
      const {
        audioContext,
        micSource,
        screenSource,
        destination,
        mixedAudioTrack,
      } = this.audioMixingResources
      try {
        mixedAudioTrack?.stop()
        micSource?.disconnect()
        screenSource?.disconnect()
        destination?.disconnect()
        audioContext
          ?.close()
          .catch((e) => console.error('Error closing mixing AudioContext:', e))
      } catch (e) {
        console.error('Error during audio mixing resource cleanup:', e)
      } finally {
        this.audioMixingResources = null
      }
    }
  }

  private cleanupScreenShareResources() {
    console.log('[PeerManager] Cleaning up screen share resources...')
    const screenVideoTrack = this.screenStream?.getVideoTracks()[0]
    if (this.screenShareTrackEndedListener && screenVideoTrack) {
      try {
        screenVideoTrack.removeEventListener(
          'ended',
          this.screenShareTrackEndedListener
        )
      } catch (removeError) {
        console.error("Error removing 'ended' listener:", removeError)
      }
      this.screenShareTrackEndedListener = null
    }

    this.screenStream?.getTracks().forEach((track) => track.stop())
    this.screenStream = null
    console.log(
      '[PeerManager cleanupScreenShareResources] Calling onLocalScreenStreamUpdate(null) callback...',
      this.options?.onLocalScreenStreamUpdate
        ? 'Callback exists'
        : 'Callback missing'
    )

    this.options?.onLocalScreenStreamUpdate?.(null)
    this.cleanupAudioMixingResources()
  }

  public disconnectAll() {
    console.log(`[PeerManager instance ${this.peer?.id}] disconnectAll called.`)
    this.isCurrentlyScreenSharing = false
    this.cleanupScreenShareResources()
    this.stopAllAudioAnalysis()

    Object.values(this.mediaConnections).forEach((conn) => conn.close())
    Object.values(this.dataConnections).forEach((conn) => conn.close())
    Object.values(this.screenMediaConnections).forEach((conn) => conn.close())
    this.mediaConnections = {}
    this.dataConnections = {}
    this.screenMediaConnections = {}

    if (this.peer && !this.peer.destroyed) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Destroying peer instance.`
      )
      this.peer.destroy()
    }
    this.peer = null

    this.localStream?.getTracks().forEach((track) => track.stop())
    this.localStream = null
    this.originalMicTrack = null // ★ リセット
    this.silentAudioTrack?.stop() // ★ ダミートラック停止
    this.silentAudioTrack = null // ★ ダミートラックのリセット

    this.options = null
    this.myName = ''
    this.isMuted = false

    console.log(`[PeerManager instance] Disconnected and resources released.`)
  }
}
