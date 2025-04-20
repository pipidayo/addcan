// src/app/components/PeerManager/index.ts
import Peer, { MediaConnection, DataConnection, PeerJSOption } from 'peerjs'

// --- インターフェースと型定義 ---
type Message =
  | { type: 'USER_NAME'; payload: string }
  | { type: 'MUTE_STATUS'; payload: boolean }

export type InitPeerOptions = {
  roomCode: string // roomCode は PeerManager 内部では直接使わないかも
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
  micSource: MediaStreamAudioSourceNode
  screenSource: MediaStreamAudioSourceNode
  destination: MediaStreamAudioDestinationNode
  mixedTrack: MediaStreamTrack // 生成されたミックス音声トラック
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
  private createDummyVideoTrack(): MediaStreamVideoTrack {
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
    //   if (this.isMessage(data) && this.options) {
    //     switch (data.type) {
    //       case 'USER_NAME':
    //         this.options.onReceiveUserName(dataConn.peer, data.payload)
    //         break
    //       case 'MUTE_STATUS':
    //         this.options.onReceiveMuteStatus(dataConn.peer, data.payload)
    //         break
    //       case 'SCREEN_SHARE_STATUS':
    //         this.options.onReceiveScreenShareStatus?.(
    //           dataConn.peer,
    //           data.payload
    //         )
    //         break
    //       case 'TRACKS_UPDATED':
    //         console.log(
    //           `★★★ [PeerManager instance ${this.peer?.id}] Received TRACKS_UPDATED from ${dataConn.peer}`
    //         )
    //         this.handleTracksUpdated(dataConn.peer)
    //         break
    //     }
    //   } else {
    //     console.warn(
    //       `[PeerManager instance ${this.peer?.id}] Received unknown message type:`,
    //       data
    //     )
    //   }
    // })
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

    // 型ガード: data が object で type プロパティを持つか確認
    // if (
    //   typeof data !== 'object' ||
    //   data === null ||
    //   !('type' in data) ||
    //   typeof data.type !== 'string'
    // ) {
    //   console.warn(
    //     `[PeerManager instance ${this.peer?.id}] Received invalid data format from ${peerId}:`,
    //     data
    //   )
    //   return
    // }
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
  public async initPeer(
    options: InitPeerOptions,
    peerName: string,
    initialIsMuted: boolean = false
  ): Promise<string> {
    console.log('[PeerManager instance] initPeer called.')
    this.options = options
    this.myName = peerName
    this.isMuted = initialIsMuted

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
              // 画面共有停止は WebSocket で通知されるのでここでは不要
              // this.options?.onReceiveScreenShareStatus?.(call.peer, false);
            })
            call.on('error', (err) => {
              console.error(
                `[PeerManager instance ${this.peer?.id}] Screen share call error with ${call.peer}:`,
                err
              )
              delete this.screenMediaConnections[call.peer]
              // this.options?.onReceiveScreenShareStatus?.(call.peer, false);
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

  public sendMuteStatus(muted: boolean) {
    this.isMuted = muted
    this.localStream
      ?.getAudioTracks()
      .forEach((track) => (track.enabled = !this.isMuted))
    this.sendMessage('MUTE_STATUS', this.isMuted)
  }

  // ★★★ replaceTrackForAllConnections は音声トラック専用にする (または削除しても良い) ★★★
  // このメソッドは switchMicrophone でのみ使われる
  private async replaceTrackForAllConnections(
    newTrack: MediaStreamTrack | null,
    kind: 'audio'
  ) {
    // このメソッドは主に音声トラックの置換に使われる想定
    console.log(
      `[PeerManager instance ${this.peer?.id}] Replacing ${kind} track for all connections. New track info: id=${newTrack?.id}, kind=${newTrack?.kind}, readyState=${newTrack?.readyState}`
    )
    if (Object.keys(this.mediaConnections).length === 0) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] No media connections to replace track on.`
      )
      return
    }

    // 音声通話用の接続 (mediaConnections) に対してのみ処理を行う
    for (const peerId in this.mediaConnections) {
      const conn = this.mediaConnections[peerId]
      const peerConnection = conn.peerConnection as
        | RTCPeerConnection
        | undefined

      if (peerConnection) {
        const sender = peerConnection
          .getSenders()
          .find((s) => s.track?.kind === kind)
        if (sender) {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Found sender for ${kind} track for connection with ${peerId}. Current track: ${sender.track?.id ?? 'null'}`
          )
          try {
            console.log(
              `[PeerManager instance ${this.peer?.id}] Attempting sender.replaceTrack() for ${peerId}...`
            )
            // ★ newTrack が null でないか、readyState が 'live' か確認
            if (newTrack && newTrack.readyState !== 'live') {
              console.warn(
                `[PeerManager instance ${this.peer?.id}] Attempting to replace with a non-live track (${newTrack.readyState}) for ${peerId}.`
              )
            }
            await sender.replaceTrack(newTrack)
            console.log(
              `[PeerManager instance ${this.peer?.id}] Successfully replaced ${kind} track for ${peerId}. New track: ${sender.track?.id ?? 'null'}`
            )
          } catch (replaceError) {
            console.error(
              `[PeerManager instance ${this.peer?.id}] Failed to replace ${kind} track for ${peerId}:`,
              replaceError,
              // エラーオブジェクトの詳細も表示
              replaceError instanceof Error ? replaceError.name : '',
              replaceError instanceof Error ? replaceError.message : ''
            )
          }
        } else {
          console.warn(
            `[PeerManager instance ${this.peer?.id}] Could not find sender for ${kind} track for ${peerId}.`
          )
        }
      } else {
        console.warn(
          `[PeerManager instance ${this.peer?.id}] No peerConnection found for media connection with ${peerId}.`
        )
      }
    }
  }

  public async switchMicrophone(newDeviceId: string) {
    console.log(
      `[PeerManager instance ${this.peer?.id}] Attempting to switch microphone to ${newDeviceId}`
    )
    const currentAudioTrack = this.localStream?.getAudioTracks()[0]
    if (currentAudioTrack?.getSettings().deviceId === newDeviceId) return

    try {
      const newStream = await this.getLocalStream(newDeviceId)
      const newAudioTrack = newStream.getAudioTracks()[0]
      if (!newAudioTrack) throw new Error('Failed to get new audio track.')
      await this.replaceTrackForAllConnections(newAudioTrack, 'audio')
      console.log(
        `[PeerManager instance ${this.peer?.id}] Microphone switched successfully.`
      )
    } catch (error) {
      console.error(
        `[PeerManager instance ${this.peer?.id}] Failed to switch microphone:`,
        error
      )
      throw error
    }
  }

  public async startScreenShare() {
    if (this.screenStream) {
      console.warn('[PeerManager] Screen share already active.')
      return
    }
    console.log('[PeerManager] Starting screen share (Separate Call Method)...') // ログ変更
    let screenVideoTrack: MediaStreamTrack | null = null
    let screenAudioTrack: MediaStreamTrack | null = null // ★ 音声トラック用変数を復活

    try {
      // 1. 画面共有ストリーム（映像のみ）を取得
      console.log('[PeerManager] Requesting screen share stream (VIDEO ONLY)')
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      })

      screenVideoTrack = this.screenStream.getVideoTracks()[0]
      screenAudioTrack = this.screenStream.getAudioTracks()[0]

      if (!screenVideoTrack) {
        throw new Error('No video track found in screen share stream.')
      }
      console.log('[PeerManager] Screen share stream obtained.')
      if (screenAudioTrack) {
        console.log('[PeerManager] Screen share stream includes audio track!') // ログ追加
      } else {
        console.log(
          '[PeerManager] Screen share stream does NOT include audio track.'
        ) // ログ追加
      }

      // 2. 共有終了時のリスナーを設定
      this.screenShareTrackEndedListener = () => {
        console.log(/* ... */)
        this.stopScreenShare()
      }
      screenVideoTrack.addEventListener(
        'ended',
        this.screenShareTrackEndedListener
      )

      // 3. 接続中の各ピアに画面共有用の新しい call を開始
      const connectedPeerIds = Object.keys(this.dataConnections)
      console.log(
        `[PeerManager instance ${this.peer?.id}] Starting screen share calls to peers:`,
        connectedPeerIds
      )

      for (const peerId of connectedPeerIds) {
        if (this.screenMediaConnections[peerId]) {
          // ★ 既に接続があればスキップするログ
          console.warn(
            `[PeerManager instance ${this.peer?.id}] Screen share connection already exists for ${peerId}. Skipping.`
          )
          continue
        }
        if (!this.peer || !this.screenStream) {
          // ★ Peer または screenStream が null の場合のエラーログ
          console.error(
            `[PeerManager instance] Peer or screenStream became null unexpectedly before calling ${peerId} for screen share.`
          )
          continue // このピアへの処理をスキップ
        }
        console.log(
          `[PeerManager instance ${this.peer.id}] Calling ${peerId} for screen share...`
        )

        // 新しい call を開始し、メタデータを付与
        const screenCall = this.peer.call(peerId, this.screenStream, {
          metadata: { type: 'screenShare' },
        })

        screenCall.on('close', () => {
          console.log(
            `[PeerManager instance ${this.peer?.id}] Screen share call closed with ${peerId} (initiated side).`
          )
        })
        screenCall.on('error', (err) => {
          console.error(
            `[PeerManager instance ${this.peer?.id}] Screen share call error with ${peerId} (initiated side):`,
            err
          )
        })

        this.screenMediaConnections[peerId] = screenCall
      }

      // 4. 他のピアに通知 (WebSocket で行うのでここでは不要)

      // 5. ローカル状態更新
      this.options?.onLocalScreenStreamUpdate?.(this.screenStream)

      console.log(
        `[PeerManager instance ${this.peer?.id}] Screen sharing initiated (Separate Call Method).` // ログ変更
      )
    } catch (error) {
      console.error(/* ... */)
      this.cleanupScreenShareResources() // エラー時もクリーンアップを呼ぶように変更
      throw error
    }
  }

  public async stopScreenShare() {
    console.log(
      `[PeerManager instance ${this.peer?.id}] Attempting to stop screen share (Separate Call Method).` // ログ変更
    )
    if (
      !this.screenStream &&
      Object.keys(this.screenMediaConnections).length === 0
    ) {
      console.log(/* ... */)
      return
    }

    // 1. 画面共有関連リソースのクリーンアップを呼ぶ
    this.cleanupScreenShareResources() // これでリスナー削除、ストリーム停止、ローカル状態更新が行われる

    // 2. 画面共有用の接続をすべて閉じる
    console.log(
      `[PeerManager instance ${this.peer?.id}] Closing all screen share connections.`
    )
    Object.values(this.screenMediaConnections).forEach((conn) => conn.close())
    this.screenMediaConnections = {} // 接続情報をクリア

    // 3. 他のピアに通知 (WebSocket で行うのでここでは不要)
    // this.sendMessage('SCREEN_SHARE_STATUS', false);

    console.log(
      `[PeerManager instance ${this.peer?.id}] Screen sharing stopped (Separate Call Method).` // ログ変更
    )
    // replaceTrack は不要
  }

  // ★ 音声ミキシングリソースを解放するヘルパーメソッド
  private cleanupAudioMixingResources() {
    if (this.audioMixingResources) {
      console.log('[PeerManager] Cleaning up audio mixing resources...')
      const { audioContext, micSource, screenSource, destination, mixedTrack } =
        this.audioMixingResources
      try {
        mixedTrack?.stop() // 生成したトラックを停止
        micSource?.disconnect()
        screenSource?.disconnect()
        destination?.disconnect()
        // AudioContext を閉じる (非同期なのでエラーハンドリング推奨)
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

  // ★ 画面共有関連のリソースをまとめて解放するヘルパーメソッド
  private cleanupScreenShareResources() {
    console.log('[PeerManager] Cleaning up screen share resources...')
    // 'ended' リスナー削除
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

    // ローカルの画面共有ストリーム停止
    this.screenStream?.getTracks().forEach((track) => track.stop())
    this.screenStream = null
    this.options?.onLocalScreenStreamUpdate?.(null) // 状態更新通知

    // 音声ミキシングリソース解放
    this.cleanupAudioMixingResources()

    // screenMediaConnections のクリアは不要になった
  }

  public disconnectAll() {
    console.log(/* ... */)
    // 1. 画面共有リソースクリーンアップ (stopScreenShare ではなくこちらを呼ぶ)
    this.cleanupScreenShareResources()
    // 2. 音声分析停止
    this.stopAllAudioAnalysis()

    // 3. 音声接続、データ接続、画面共有接続を閉じる
    Object.values(this.mediaConnections).forEach((conn) => conn.close())
    Object.values(this.dataConnections).forEach((conn) => conn.close())
    // ★★★ 画面共有接続も閉じる ★★★
    Object.values(this.screenMediaConnections).forEach((conn) => conn.close())
    this.mediaConnections = {}
    this.dataConnections = {}
    this.screenMediaConnections = {} // ★ クリア

    // 4. Peer オブジェクト破棄
    if (this.peer && !this.peer.destroyed) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Destroying peer instance.`
      )
      this.peer.destroy()
    }
    this.peer = null

    // 5. ローカルストリーム停止 (マイク)
    this.localStream?.getTracks().forEach((track) => track.stop())
    this.localStream = null

    // 6. 他のプロパティリセット
    this.options = null
    this.myName = ''
    this.isMuted = false

    console.log(`[PeerManager instance] Disconnected and resources released.`)
  }
}
