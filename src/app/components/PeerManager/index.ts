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
    const peerIds = Object.keys(this.mediaConnections)
    console.log(
      `[PeerManager replaceTrackForAllConnections] Active media connections: ${peerIds.length}`
    )

    if (peerIds.length === 0) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] No media connections to replace track on.`
      )
      return
    }
    const replacePromises: Promise<void>[] = []

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
            `[PeerManager replaceTrackForAllConnections] Found sender for ${kind} track for connection with ${peerId}. Current track ID: ${sender.track?.id ?? 'null'}, Current track State: ${sender.track?.readyState ?? 'N/A'}`
          )
          replacePromises.push(
            (async () => {
              // Promise を配列に追加
              try {
                console.log(
                  `[PeerManager instance ${this.peer?.id}] Attempting sender.replaceTrack() for ${peerId}...`
                )
                // ★ newTrack が null でないか、readyState が 'live' か確認
                if (newTrack && newTrack.readyState !== 'live') {
                  console.warn(
                    `[PeerManager replaceTrackForAllConnections] WARNING: Attempting to replace with a non-live track (ID: ${newTrack.id}, State: ${newTrack.readyState}) for ${peerId}.`
                  )
                }
                await sender.replaceTrack(newTrack)
                console.log(
                  `[PeerManager replaceTrackForAllConnections] Successfully replaced ${kind} track for ${peerId}. New sender track ID: ${sender.track?.id ?? 'null'}`
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
            })()
          ) // 即時実行して Promise を返す
        } else {
          console.warn(
            `[PeerManager replaceTrackForAllConnections] Could not find sender for ${kind} track for ${peerId}.`
          )
        }
      } else {
        console.warn(
          `[PeerManager replaceTrackForAllConnections] No peerConnection found for media connection with ${peerId}.`
        )
      }
    }
    // すべての replaceTrack 処理が完了するのを待つ
    await Promise.all(replacePromises)
  }

  public async switchMicrophone(newDeviceId: string) {
    console.log(
      `[PeerManager instance ${this.peer?.id}] Attempting to switch microphone to ${newDeviceId}`
    )
    const currentAudioTrack = this.localStream?.getAudioTracks()[0]
    if (currentAudioTrack?.getSettings().deviceId === newDeviceId) return

    // ★ 1. 古いローカルオーディオトラックを保持 (後で停止するため)
    const oldLocalAudioTrack = this.localStream?.getAudioTracks()[0]
    console.log(
      `[PeerManager switchMicrophone] Old local audio track ID: ${oldLocalAudioTrack?.id}, State: ${oldLocalAudioTrack?.readyState}`
    )

    try {
      // ★ 2. 新しいマイクから新しい音声ストリームとトラックを取得
      //    この時点では this.localStream はまだ更新せず、古いトラックも停止しない
      console.log(
        `[PeerManager switchMicrophone] Requesting new audio track for deviceId: ${newDeviceId}`
      )
      const newMicStream = await navigator.mediaDevices.getUserMedia({
        audio: newDeviceId ? { deviceId: { exact: newDeviceId } } : true,
      })
      const newAudioTrack = newMicStream.getAudioTracks()[0]

      if (!newAudioTrack) {
        console.error(
          `[PeerManager switchMicrophone] Failed to get new audio track from newMicStream for deviceId: ${newDeviceId}.`
        )
        newMicStream.getTracks().forEach((track) => track.stop()) // 取得したストリームを破棄

        throw new Error('Failed to get new audio track.')
      }
      if (newAudioTrack.readyState !== 'live') {
        console.warn(
          `[PeerManager switchMicrophone] New audio track (ID: ${newAudioTrack.id}) for mic switch is not live. State: ${newAudioTrack.readyState}. Aborting switch.`
        )
        newAudioTrack.stop() // 取得したトラックを停止
        newMicStream.getTracks().forEach((track) => track.stop()) // ストリーム全体のトラックも停止
        throw new Error(
          `New audio track is not live: ${newAudioTrack.readyState}`
        )
      }

      console.log(
        `[PeerManager switchMicrophone] Successfully obtained new audio track: ID=${newAudioTrack.id}, State=${newAudioTrack.readyState}`
      )

      // ★新しい音声トラックの有効状態を早期に設定
      newAudioTrack.enabled = !this.isMuted
      console.log(
        `[PeerManager switchMicrophone] Set newAudioTrack.enabled to ${newAudioTrack.enabled} (isMuted: ${this.isMuted})`
      )

      // ★ 3. 通常の音声通話接続のトラックを更新
      console.log(
        `[PeerManager switchMicrophone] Calling replaceTrackForAllConnections with new audio track ID: ${newAudioTrack.id}`
      )

      await this.replaceTrackForAllConnections(newAudioTrack, 'audio')

      // ★ 4. 画面共有中の場合、画面共有接続の送信トラックも更新
      if (
        this.isCurrentlyScreenSharing &&
        newAudioTrack.readyState === 'live'
      ) {
        console.log(
          `[PeerManager switchMicrophone] Screen sharing is active. Updating audio track for screen share connections. New mic track ID: ${newAudioTrack.id}, State: ${newAudioTrack.readyState}`
        )

        let trackForScreenShare: MediaStreamTrack | null = null

        // ★★★ デバッグ中は常に新しいマイクのクローンを使用 ★★★
        // (ミキシングが有効な場合は、ここでミキシング処理を再構築し、
        //  newMixedAudioTrackForScreenShare を trackForScreenShare に設定するロジックが必要になります)
        console.log(
          '[PeerManager switchMicrophone DEBUG] Audio mixing is disabled for screen share track update.'
        )
        try {
          trackForScreenShare = newAudioTrack.clone()
          console.log(
            `[PeerManager switchMicrophone DEBUG] Using cloned newAudioTrack directly for screen share. ID=${trackForScreenShare.id}`
          )
        } catch (e) {
          console.error(
            '[PeerManager switchMicrophone DEBUG] Failed to clone newAudioTrack for screen share, using original',
            e
          )
          trackForScreenShare = newAudioTrack
        }
        if (trackForScreenShare) {
          // nullチェックを追加
          trackForScreenShare.enabled = !this.isMuted // ミュート状態を適用
        }

        if (trackForScreenShare && trackForScreenShare.readyState === 'live') {
          console.log(
            `[PeerManager switchMicrophone DEBUG] Screen share track to use: ID=${trackForScreenShare.id}, Enabled=${trackForScreenShare.enabled}`
          )
          console.log(
            `[PeerManager switchMicrophone] newMixedAudioTrackForScreenShare.enabled: ${trackForScreenShare.enabled}` // 変数名を修正
          )

          // d. 各画面共有接続の音声トラックを新しいミックス音声トラックに置き換える
          console.log(
            `[PeerManager switchMicrophone] Replacing audio track for active screen share connections with new track (ID: ${trackForScreenShare.id}, State: ${trackForScreenShare.readyState}).`
          )
          for (const peerId in this.screenMediaConnections) {
            const conn = this.screenMediaConnections[peerId]
            const peerConnection = conn.peerConnection as
              | RTCPeerConnection
              | undefined
            if (peerConnection) {
              const sender = peerConnection
                .getSenders()
                .find((s) => s.track?.kind === 'audio')
              if (sender) {
                try {
                  const trackToReplaceWith = trackForScreenShare // 更新されたトラックを使用
                  if (
                    trackToReplaceWith &&
                    trackToReplaceWith.readyState === 'live'
                  ) {
                    // enabled も確認すべきか
                    console.log(
                      `[PeerManager switchMicrophone] Replacing track for screenMediaConnection to ${peerId} with track ID ${trackToReplaceWith.id}, State: ${trackToReplaceWith.readyState}, Enabled: ${trackToReplaceWith.enabled}`
                    )
                    await sender.replaceTrack(trackToReplaceWith)
                  } else {
                    console.warn(
                      `[PeerManager switchMicrophone] Track for screenMediaConnection to ${peerId} is null, not live, or not enabled. Skipping replaceTrack. Track ID: ${trackToReplaceWith?.id}, State: ${trackToReplaceWith?.readyState}, Enabled: ${trackToReplaceWith?.enabled}`
                    )
                  }

                  console.log(
                    `[PeerManager switchMicrophone] Successfully replaced audio track for screen share with ${peerId}. New sender track ID: ${sender.track?.id}, State: ${sender.track?.readyState}`
                  )
                } catch (err) {
                  console.error(
                    `[PeerManager switchMicrophone] Failed to replace audio track for screen share with ${peerId} using track ID ${trackForScreenShare.id}:`,
                    err
                  )
                }
              } else {
                console.warn(
                  `[PeerManager switchMicrophone] No audio sender found for screen share connection with ${peerId}.`
                )
              }
            }
          }
        } else {
          console.warn(
            `[PeerManager switchMicrophone] trackForScreenShare is null or not live. State: ${trackForScreenShare?.readyState}. Screen share audio will not be updated with new mic.`
          )
        }
      }

      // ★ newAudioTrack のクローンを localStream に使用する
      let trackForLocalStream = newAudioTrack
      try {
        trackForLocalStream = newAudioTrack.clone()
        console.log(
          `[PeerManager switchMicrophone] Cloned newAudioTrack for localStream: Original ID=${newAudioTrack.id}, Clone ID=${trackForLocalStream.id}`
        )
      } catch (cloneError) {
        console.warn(
          `[PeerManager switchMicrophone] Failed to clone newAudioTrack for localStream, using original. Error:`,
          cloneError
        )
      }
      // ★ this.localStream を再構築する直前の newAudioTrack の状態をログに出力
      console.log(
        `[PeerManager switchMicrophone] Before reconstructing localStream. trackForLocalStream ID: ${trackForLocalStream.id}, State: ${trackForLocalStream.readyState}, Enabled: ${trackForLocalStream.enabled}`
      )

      // 6. this.localStream を新しいオーディオトラックで再構築
      // (ダミービデオトラックは維持する)
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
      this.options?.onLocalStream(this.localStream) // 新しいlocalStreamをUIに通知
      // newAudioTrack.enabled = !this.isMuted; // ★ 有効化処理を早期に移動したため、ここでは不要

      console.log(
        `[PeerManager switchMicrophone] Microphone switched successfully to device ID: ${newDeviceId}. Final localStream audio track ID: ${trackForLocalStream.id}`
      )

      // ★★★ 5. 古いローカルオーディオトラックをメソッドの最後に停止 ★★★
      if (
        oldLocalAudioTrack &&
        oldLocalAudioTrack.id !== newAudioTrack.id && // newAudioTrack はオリジナルのまま比較
        oldLocalAudioTrack.readyState === 'live'
      ) {
        console.log(
          `[PeerManager switchMicrophone] (Finally) Stopping old local audio track: ID=${oldLocalAudioTrack.id}, State=${oldLocalAudioTrack.readyState}`
        )
        oldLocalAudioTrack.stop()
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
    // 自身の Peer オブジェクト、画面共有ストリーム、共有状態フラグを確認
    if (!this.peer || !this.isCurrentlyScreenSharing) {
      console.warn(
        `[PeerManager] Cannot start screen share to peer ${peerId}: Not ready or not sharing.`
      )
      return
    }
    // 既に接続があれば何もしない
    if (this.screenMediaConnections[peerId]) {
      console.log(
        `[PeerManager] Screen share connection to ${peerId} already exists.`
      )
      return
    }

    // 共有するストリームを取得 (ミックス音声があればそれを含む)
    const streamToShare = new MediaStream()
    const screenVideoTrack = this.screenStream?.getVideoTracks()[0]
    // ★★★ ミキシング無効化中は this.audioMixingResources が null なので、直接 this.localStream の音声トラックを参照 ★★★
    const audioTrackToShare =
      this.audioMixingResources?.mixedAudioTrack ??
      this.localStream?.getAudioTracks()[0]

    if (!screenVideoTrack) {
      console.error(
        `[PeerManager] Cannot start screen share to peer ${peerId}: Screen video track unavailable.`
      )
      return
    }
    streamToShare.addTrack(screenVideoTrack)
    if (audioTrackToShare) {
      streamToShare.addTrack(audioTrackToShare)
      console.log(
        `[PeerManager] Preparing screen share stream for ${peerId} with video and audio.`
      )
    } else {
      console.log(
        `[PeerManager] Preparing screen share stream for ${peerId} with video only.`
      )
    }

    console.log(
      `[PeerManager instance ${this.peer.id}] Calling ${peerId} for screen share (new peer)...`
    )
    try {
      // 画面共有用の call を開始し、メタデータを付与
      const screenCall = this.peer.call(peerId, streamToShare, {
        metadata: { type: 'screenShare' },
      })
      if (!screenCall) {
        throw new Error('Failed to initiate screen share call.')
      }

      // イベントハンドラを設定
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

      // 接続を管理リストに追加
      this.screenMediaConnections[peerId] = screenCall
      console.log(
        `[PeerManager] Screen share call initiated to new peer ${peerId}`
      )
    } catch (error) {
      console.error(
        `[PeerManager] Error starting screen share call to new peer ${peerId}:`,
        error
      )
      // 必要に応じてエラー処理
    }
  }

  public async startScreenShare() {
    if (this.isCurrentlyScreenSharing) {
      console.warn('[PeerManager] Screen share already active.')
      return
    }
    // ★ ミキシング処理を開始する前に、既存のリソースがあれば解放
    this.cleanupAudioMixingResources()

    console.log('[PeerManager] Starting screen share (Separate Call Method)...') // ログ変更
    let screenVideoTrack: MediaStreamTrack | null = null
    let mixedAudioTrack: MediaStreamTrack | null = null

    try {
      // 1. マイク音声トラックを取得 (localStream がなければ取得試行)
      if (!this.localStream) {
        await this.getLocalStream()
      }
      const micAudioTrack = this.localStream?.getAudioTracks()[0]
      if (!micAudioTrack) {
        // マイクがない場合でも画面共有は続けられるかもしれないが、警告を出す
        console.warn(
          '[PeerManager startScreenShare] Microphone audio track is unavailable for mixing.'
        )
        // throw new Error('Microphone audio track is unavailable.'); // エラーにするかは要件次第
      } else {
        console.log(
          '[PeerManager] Got microphone audio track for mixing:',
          micAudioTrack.id
        )
      }

      // 2. 画面共有ストリーム（映像＋音声）を取得
      console.log(
        '[PeerManager] Requesting screen share stream (VIDEO + AUDIO)'
      )
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true, // システム音声も取得しようと試みる
        })
      } catch (err: unknown) {
        // ユーザーによるキャンセル (NotAllowedError) かどうかを判定
        if (err instanceof Error && err.name === 'NotAllowedError') {
          console.log('[PeerManager] Screen share cancelled by user.')
          this.cleanupScreenShareResources() // 念のためリソース解放
          //  サーバーに画面共有が開始されなかった(キャンセルされた)ことを通知
          if (this.socket && this.socket.connected) {
            console.log(
              '[PeerManager] Notifying server of screen share cancellation (emit notify-stop-share).'
            )
            this.socket.emit('notify-stop-share') // サーバー側の共有状態をリセットさせる
          } else {
            console.warn(
              '[PeerManager] Socket not available or not connected, cannot notify server of cancellation.'
            )
          }
          // isCurrentlyScreenSharing はこの時点では false のままのはず
          return
        } else {
          // その他のエラー (デバイスが見つからないなど)
          console.error('[PeerManager] Error getting display media:', err)
          // ★ 他のエラーは呼び出し元に投げる
          throw err
        }
      }

      screenVideoTrack = this.screenStream.getVideoTracks()[0]
      const screenAudioTrack = this.screenStream.getAudioTracks()[0] // 画面共有の音声トラック

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

      // --- 3. Web Audio API で音声をミックス ---
      console.log('[PeerManager] Setting up Web Audio API for mixing...')

      // ★★★ デバッグのためミキシング処理とリソースクリーンアップを一時的に無効化 ★★★
      if (micAudioTrack) {
        try {
          mixedAudioTrack = micAudioTrack.clone()
          console.log(
            `[PeerManager startScreenShare DEBUG] Using cloned micAudioTrack directly. ID=${mixedAudioTrack.id}`
          )
        } catch (e) {
          console.error(
            '[PeerManager startScreenShare DEBUG] Failed to clone micAudioTrack, using original',
            e
          )
          mixedAudioTrack = micAudioTrack
        }
        // this.audioMixingResources はミキシング無効化中は null のまま
        // this.cleanupAudioMixingResources(); // ミキシングしないので不要
      } else {
        console.warn(
          '[PeerManager startScreenShare DEBUG] No mic audio track available for screen share.'
        )
        mixedAudioTrack = null
        // this.cleanupAudioMixingResources(); // ミキシングしないので不要
      }
      // try {
      //   const audioContext = new AudioContext()
      //   const destination = audioContext.createMediaStreamDestination() // 出力先ノード

      //   let micSource: MediaStreamAudioSourceNode | null = null
      //   if (micAudioTrack && this.localStream) {
      //     // マイク音声があれば接続
      //     micSource = audioContext.createMediaStreamSource(
      //       new MediaStream([micAudioTrack])
      //     )
      //     micSource.connect(destination)
      //     console.log('[PeerManager] Connected mic audio to mixer.')
      //   }

      //   let screenSource: MediaStreamAudioSourceNode | null = null
      //   if (screenAudioTrack && this.screenStream) {
      //     // 画面共有音声があれば接続
      //     screenSource = audioContext.createMediaStreamSource(
      //       new MediaStream([screenAudioTrack])
      //     )
      //     screenSource.connect(destination)
      //     console.log('[PeerManager] Connected screen audio to mixer.')
      //   }

      //   if (destination.stream.getAudioTracks().length > 0) {
      //     mixedAudioTrack = destination.stream.getAudioTracks()[0]
      //     console.log(
      //       '[PeerManager] Successfully mixed audio tracks:',
      //       mixedAudioTrack.id
      //     )
      //     this.audioMixingResources = {
      //       audioContext,
      //       micSource,
      //       screenSource,
      //       destination,
      //       mixedAudioTrack: mixedAudioTrack,
      //     }
      //   } else if (micAudioTrack) {
      //     console.warn(
      //       '[PeerManager] Could not get mixed audio track, falling back to mic audio.'
      //     )
      //     mixedAudioTrack = micAudioTrack
      //     this.cleanupAudioMixingResources()
      //   } else {
      //     console.warn('[PeerManager] No audio sources available to send.')
      //     mixedAudioTrack = null
      //     this.cleanupAudioMixingResources()
      //   }
      // } catch (mixError) {
      //   console.error('[PeerManager] Error during Web Audio mixing:', mixError)
      //   mixedAudioTrack = micAudioTrack ?? null
      //   console.warn(
      //     `[PeerManager] Falling back to ${mixedAudioTrack ? 'mic audio' : 'no audio'} due to mixing error.`
      //   )
      //   this.cleanupAudioMixingResources()
      // }

      //  共有状態フラグを立てる
      this.isCurrentlyScreenSharing = true
      // --- ここまで音声ミックス処理 ---

      // 4. 共有終了時のリスナーを設定 (映像トラックに対して)
      this.screenShareTrackEndedListener = () => {
        console.log(
          `[PeerManager instance ${this.peer?.id}] Screen share track ended listener triggered.`
        )
        this.stopScreenShare()
      }
      // screenVideoTrack は try ブロックの先頭で取得済みのはず
      if (!screenVideoTrack) {
        throw new Error(
          "Screen video track is unexpectedly null before adding 'ended' listener."
        )
      }
      screenVideoTrack.addEventListener(
        'ended',
        this.screenShareTrackEndedListener
      )

      // 5. 接続中の各ピアに画面共有用の新しい call を開始
      const connectedPeerIds = Object.keys(this.dataConnections)
      console.log(
        `[PeerManager instance ${this.peer?.id}] Starting screen share calls to existing peers (DataConnections):`, // ログメッセージ修正
        connectedPeerIds
      )

      await Promise.all(
        connectedPeerIds.map((peerId) => this.startScreenShareToPeer(peerId))
      )

      // 6. ローカル状態更新 (ローカルプレビュー用には元の screenStream を渡す)
      console.log(
        '[PeerManager startScreenShare] Calling onLocalScreenStreamUpdate callback...',
        this.options?.onLocalScreenStreamUpdate
          ? 'Callback exists'
          : 'Callback missing'
      )
      this.options?.onLocalScreenStreamUpdate?.(this.screenStream)

      console.log(
        `[PeerManager instance ${this.peer?.id}] Screen sharing initiated (Separate Call Method with Audio Mixing).`
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
    // ★★★ フラグでチェック ★★★
    if (!this.isCurrentlyScreenSharing) {
      console.log(
        `[PeerManager instance ${this.peer?.id}] Screen sharing is not active.`
      )
      return
    }

    // ★★★ 共有状態フラグを降ろす ★★★
    this.isCurrentlyScreenSharing = false

    // 1. 画面共有関連リソースのクリーンアップ (変更なし)
    this.cleanupScreenShareResources()

    // 2. 画面共有用の接続をすべて閉じる (変更なし)
    console.log(
      `[PeerManager instance ${this.peer?.id}] Closing all screen share connections.`
    )
    Object.values(this.screenMediaConnections).forEach((conn) => conn.close())
    this.screenMediaConnections = {}

    // ★★★ 3. サーバーに共有停止を通知 ★★★
    if (this.socket && this.peer?.id && this.roomCode) {
      console.log('[PeerManager] Notifying server of stop share...')
      this.socket.emit('notify-stop-share') // サーバー側のイベント名に合わせる
    } else {
      console.warn(
        '[PeerManager stopScreenShare] Socket/PeerID/RoomCode missing, could not notify server.'
      )
    }

    // ★★★ 通常の音声通話接続のトラックを再確認/再設定 ★★★
    //    画面共有中にマイクが変更された場合に備えて、現在の localStream の音声トラックを
    //    通常の音声通話接続に再度適用する。
    const currentMicTrack = this.localStream?.getAudioTracks()[0]
    if (currentMicTrack && currentMicTrack.readyState === 'live') {
      console.log(
        `[PeerManager stopScreenShare] Re-applying current mic track (ID: ${currentMicTrack.id}, State: ${currentMicTrack.readyState}) to mediaConnections.`
      )
      // replaceTrackForAllConnections は mediaConnections のみを対象とする
      await this.replaceTrackForAllConnections(currentMicTrack, 'audio')
    } else {
      console.warn(
        `[PeerManager stopScreenShare] Current mic track is not available or not live after stopping screen share. ID: ${currentMicTrack?.id}, State: ${currentMicTrack?.readyState}. Voice might not be sent on mediaConnections.`
      )
    }

    console.log(
      `[PeerManager instance ${this.peer?.id}] Screen sharing stopped.`
    )
  }

  // ★ 音声ミキシングリソースを解放するヘルパーメソッド
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
        mixedAudioTrack?.stop() // 生成したトラックを停止
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
    console.log(
      '[PeerManager cleanupScreenShareResources] Calling onLocalScreenStreamUpdate(null) callback...',
      this.options?.onLocalScreenStreamUpdate
        ? 'Callback exists'
        : 'Callback missing'
    )

    this.options?.onLocalScreenStreamUpdate?.(null) // 状態更新通知

    // 音声ミキシングリソース解放
    this.cleanupAudioMixingResources()

    // screenMediaConnections のクリアは不要になった
  }

  public disconnectAll() {
    console.log(`[PeerManager instance ${this.peer?.id}] disconnectAll called.`)
    this.isCurrentlyScreenSharing = false
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
